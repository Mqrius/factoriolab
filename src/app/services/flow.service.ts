import { Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { combineLatest, map, Observable, switchMap } from 'rxjs';

import {
  Column,
  Dataset,
  FlowData,
  FlowStyle,
  NodeType,
  Rational,
  Step,
  themeMap,
} from '~/models';
import { LabState, Preferences, Products, Recipes, Settings } from '~/store';
import { ColumnsState } from '~/store/preferences';
import { ThemeService } from './theme.service';

@Injectable({
  providedIn: 'root',
})
export class FlowService {
  flowData$: Observable<FlowData>;

  constructor(
    private translateSvc: TranslateService,
    private store: Store<LabState>,
    private theme: ThemeService
  ) {
    this.flowData$ = combineLatest([
      this.store.select(Products.getSteps),
      this.store.select(Recipes.getAdjustedDataset),
      this.store
        .select(Settings.getDisplayRateInfo)
        .pipe(switchMap((dr) => this.translateSvc.get(dr.suffix))),
      this.store.select(Preferences.getColumns),
      this.theme.theme$,
    ]).pipe(
      map(([steps, data, suffix, columns, theme]) =>
        this.buildGraph(steps, data, suffix, columns, themeMap[theme])
      )
    );
  }

  buildGraph(
    steps: Step[],
    data: Dataset,
    suffix: string,
    columns: ColumnsState,
    theme: FlowStyle
  ): FlowData {
    const flow: FlowData = {
      theme,
      nodes: [],
      links: [],
    };

    const itemPrec = columns[Column.Items].precision;
    const factoryPrec = columns[Column.Factories].precision;

    for (const step of steps) {
      if (step.recipeId && step.factories) {
        const recipe = data.recipeEntities[step.recipeId];
        const settings = step.recipeSettings;

        if (settings?.factoryId != null) {
          const factory = data.itemEntities[settings.factoryId];
          // CREATE NODE: Standard recipe
          flow.nodes.push({
            id: `r|${step.id}`,
            type: step.producerId
              ? NodeType.Output
              : Object.keys(recipe.in).length === 0
              ? NodeType.Input
              : NodeType.Recipe,
            name: recipe.name,
            text: `${step.factories.toString(factoryPrec)} ${factory.name}`,
            recipe,
            factoryId: settings.factoryId,
            factories: step.factories.toString(factoryPrec),
          });
        }
      }

      if (step.itemId) {
        const item = data.itemEntities[step.itemId];
        if (step.surplus) {
          // CREATE NODE: Surplus
          flow.nodes.push({
            id: `s|${step.itemId}`,
            type: NodeType.Surplus,
            name: item.name,
            text: `${step.surplus.toString(itemPrec)}${suffix}`,
          });
          // Links to surplus node
          for (const sourceStep of steps) {
            if (sourceStep.recipeId && sourceStep.outputs) {
              if (sourceStep.outputs[step.itemId]) {
                const sourceAmount = step.surplus.mul(
                  sourceStep.outputs[step.itemId]
                );
                // CREATE LINK: Recipe -> Surplus
                flow.links.push({
                  source: `r|${sourceStep.id}`,
                  target: `s|${step.itemId}`,
                  name: item.name,
                  text: `${sourceAmount.toString(itemPrec)}${suffix}`,
                });
              }
            }
          }
        }

        if (step.items) {
          let itemAmount = step.items;
          if (step.parents) {
            let inputAmount = Rational.zero;

            // Links to recipe node
            for (const targetId of Object.keys(step.parents)) {
              // This is how much is requested by that step,
              // but need recipe source
              const targetAmount = step.items.mul(step.parents[targetId]);
              // Keep track of remaining amounts
              let amount = targetAmount;
              itemAmount = itemAmount.sub(amount);
              for (const sourceStep of steps) {
                if (sourceStep.recipeId && sourceStep.outputs) {
                  if (sourceStep.outputs[step.itemId]) {
                    if (!sourceStep.recipe?.produces(item.id)) {
                      // This step does not actually produce this item
                      // All of this item output should feed into itself
                      if (sourceStep.id === targetId) {
                        // Target and source step match, put all output here
                        // Ignore parents in this case, we want all output
                        const sourceAmount = step.items.mul(
                          sourceStep.outputs[step.itemId]
                        );
                        amount = amount.sub(sourceAmount);

                        // CREATE LINK: Recipe -> Recipe (Self-link)
                        flow.links.push({
                          source: `r|${sourceStep.id}`,
                          target: `r|${targetId}`,
                          name: item.name,
                          text: `${sourceAmount.toString(itemPrec)}${suffix}`,
                        });
                      }
                    } else {
                      // This source step produces this item
                      const sourceAmount = targetAmount.mul(
                        sourceStep.outputs[step.itemId]
                      );
                      amount = amount.sub(sourceAmount);

                      // CREATE LINK: Recipe -> Recipe
                      flow.links.push({
                        source: `r|${sourceStep.id}`,
                        target: `r|${targetId}`,
                        name: item.name,
                        text: `${sourceAmount.toString(itemPrec)}${suffix}`,
                      });
                    }
                  }
                }
              }

              if (amount.gt(Rational.zero)) {
                inputAmount = inputAmount.add(amount);
                // CREATE LINK: Input -> Recipe
                flow.links.push({
                  source: `i|${step.itemId}`,
                  target: `r|${targetId}`,
                  name: item.name,
                  text: `${amount.toString(itemPrec)}${suffix}`,
                });
              }
            }

            if (inputAmount.gt(Rational.zero)) {
              // CREATE NODE: Input
              flow.nodes.push({
                id: `i|${step.itemId}`,
                type: NodeType.Input,
                name: item.name,
                text: `${inputAmount.toString(itemPrec)}${suffix}`,
              });
            }
          }

          if (step.output) {
            // CREATE NODE: Output
            flow.nodes.push({
              id: `o|${step.itemId}`,
              type: NodeType.Output,
              name: item.name,
              text: `${step.output.toString(itemPrec)}${suffix}`,
            });
            for (const sourceStep of steps) {
              if (sourceStep.recipeId && sourceStep.outputs) {
                if (sourceStep.outputs[step.itemId]) {
                  // CREATE LINK: Recipe -> Output
                  flow.links.push({
                    source: `r|${sourceStep.id}`,
                    target: `o|${step.itemId}`,
                    name: item.name,
                    text: `${step.output
                      .mul(sourceStep.outputs[step.itemId])
                      .toString(itemPrec)}${suffix}`,
                  });
                }
              }
            }
          }
        }
      }
    }

    return flow;
  }
}
