import "server-only";
import allflameHoldout from "./models/holdout/Allflame.json";
import mirageHoldout from "./models/holdout/Mirage.json";
import { createPredictor, type PredictorModel, type PredictorRuntime } from "./prediction-model";

/**
 * The model the Past league simulator scores each league with: one trained WITHOUT that league
 * (ml/fit_production.py validate writes it as ml/cache/tsrows/model_holdout_<League>.json; copy it to
 * lib/models/holdout/<League>.json after a retrain). The shipped lib/models/predictor.json trains on
 * every finished league, so replaying one of them with it would grade the model on its own training
 * data. Only the simulator imports this file, so these ~4.6 MB models don't ship with other routes.
 */
const MODELS: Record<string, PredictorModel> = {
  Allflame: allflameHoldout as unknown as PredictorModel,
  Mirage: mirageHoldout as unknown as PredictorModel,
};

const runtimes = new Map<string, PredictorRuntime>();

export function holdoutRuntime(league: string): PredictorRuntime {
  const model = MODELS[league];
  if (!model) throw new Error(`No model trained without ${league} in lib/models/holdout/`);
  let rt = runtimes.get(league);
  if (!rt) runtimes.set(league, (rt = createPredictor(model)));
  return rt;
}
