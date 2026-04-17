export type VadFrame = {
  rms: number;
  timestampMs: number;
};

export const DEFAULT_VAD_THRESHOLD = 0.01;

export const computeRms = (timeDomainSamples: Float32Array) => {
  if (timeDomainSamples.length === 0) {
    return 0;
  }

  let total = 0;

  for (let index = 0; index < timeDomainSamples.length; index += 1) {
    total += timeDomainSamples[index] * timeDomainSamples[index];
  }

  return Math.sqrt(total / timeDomainSamples.length);
};

export const isSpeechFrame = (rms: number, threshold = DEFAULT_VAD_THRESHOLD) => rms > threshold;

export const pruneVadFrames = (frames: VadFrame[], minTimestampMs: number) =>
  frames.filter((frame) => frame.timestampMs >= minTimestampMs);

export const getSpeechRatio = (
  frames: VadFrame[],
  sinceTimestampMs: number,
  threshold = DEFAULT_VAD_THRESHOLD,
) => {
  const relevantFrames = frames.filter((frame) => frame.timestampMs >= sinceTimestampMs);

  if (relevantFrames.length === 0) {
    return 0;
  }

  const speechFrames = relevantFrames.filter((frame) => isSpeechFrame(frame.rms, threshold)).length;

  return speechFrames / relevantFrames.length;
};
