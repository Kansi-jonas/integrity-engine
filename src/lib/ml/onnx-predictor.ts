// ─── ONNX Predictor ──────────────────────────────────────────────────────────
// Loads a LightGBM model exported to ONNX format and runs inference in Node.js.
// Falls back to the existing Random Forest if ONNX model is not available.
//
// Usage:
//   1. Train model: python scripts/train-lightgbm.py --db /data/integrity.db
//   2. Model saved to /data/quality-model.onnx
//   3. This module auto-loads it on first prediction
//
// Inference: <1ms per prediction via onnxruntime-node

import fs from "fs";
import path from "path";
import { extractFeatures, FeatureInput, FEATURE_NAMES } from "./feature-engineering";

let onnxSession: any = null;
let onnxAvailable = false;
let onnxChecked = false;
let modelMeta: any = null;

/**
 * Try to load ONNX model. Non-blocking — returns false if unavailable.
 */
async function ensureOnnx(dataDir: string): Promise<boolean> {
  if (onnxChecked) return onnxAvailable;
  onnxChecked = true;

  const modelPath = path.join(dataDir, "quality-model.onnx");
  const metaPath = path.join(dataDir, "quality-model-meta.json");

  if (!fs.existsSync(modelPath)) {
    console.log("[ONNX] No model file at", modelPath);
    return false;
  }

  try {
    // Dynamic import — onnxruntime-node may not be installed
    // @ts-ignore — onnxruntime-node is optional, loaded dynamically
    const ort = await import("onnxruntime-node");
    onnxSession = await ort.InferenceSession.create(modelPath);
    onnxAvailable = true;

    // Load metadata
    if (fs.existsSync(metaPath)) {
      modelMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      console.log(`[ONNX] Model loaded — R²=${modelMeta.r2}, RMSE=${modelMeta.rmse}, trained on ${modelMeta.n_train} samples`);
    } else {
      console.log("[ONNX] Model loaded (no metadata)");
    }

    return true;
  } catch (e) {
    console.log("[ONNX] onnxruntime-node not available, using Random Forest fallback");
    return false;
  }
}

/**
 * Predict fix rate using ONNX model.
 * Returns null if ONNX not available (caller should use RF fallback).
 */
export async function predictWithOnnx(
  input: FeatureInput,
  dataDir: string
): Promise<{ predicted: number; confidence: "high" | "medium" | "low"; model: string } | null> {
  const available = await ensureOnnx(dataDir);
  if (!available || !onnxSession) return null;

  try {
    const features = extractFeatures(input);
    // @ts-ignore — onnxruntime-node is optional, loaded dynamically
    const ort = await import("onnxruntime-node");

    // Create tensor [1, 18]
    const tensor = new ort.Tensor("float32", features, [1, FEATURE_NAMES.length]);
    const feeds: Record<string, any> = {};
    const inputNames = onnxSession.inputNames;
    feeds[inputNames[0]] = tensor;

    const results = await onnxSession.run(feeds);
    const outputNames = onnxSession.outputNames;
    const output = results[outputNames[0]];

    let predicted = output.data[0] as number;
    predicted = Math.max(0, Math.min(100, predicted));

    // Confidence based on model R² and prediction extremity
    const r2 = modelMeta?.r2 || 0.5;
    let confidence: "high" | "medium" | "low";
    if (r2 > 0.7 && predicted > 20 && predicted < 95) confidence = "high";
    else if (r2 > 0.5) confidence = "medium";
    else confidence = "low";

    return {
      predicted: Math.round(predicted * 10) / 10,
      confidence,
      model: `LightGBM/ONNX (R²=${modelMeta?.r2 || "?"})`,
    };
  } catch (e) {
    console.error("[ONNX] Inference failed:", e);
    return null;
  }
}

/**
 * Get model info (for API/dashboard).
 */
export function getModelInfo(): any {
  return {
    onnx_available: onnxAvailable,
    meta: modelMeta,
    feature_names: FEATURE_NAMES,
  };
}

/**
 * Force reload of ONNX model (after retraining).
 */
export function reloadModel() {
  onnxChecked = false;
  onnxSession = null;
  onnxAvailable = false;
  modelMeta = null;
}
