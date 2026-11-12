import {
  FaceLandmarker,
  FilesetResolver
} from "./vendor/mediapipe/vision_bundle.mjs";

const WASM_ROOT = new URL("./vendor/mediapipe/wasm", import.meta.url).href;
const MODEL_URL = new URL("./vendor/mediapipe/face_landmarker.task", import.meta.url).href;

export async function createMediaPipeFaceTracker({ maxFaces = 5, preferCpu = false } = {}) {
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  let landmarker;

  if (preferCpu) {
    landmarker = await createLandmarker(vision, maxFaces, "CPU");
  } else {
    try {
      landmarker = await createLandmarker(vision, maxFaces, "GPU");
    } catch (gpuError) {
      console.warn("MediaPipe GPU initialization failed; using CPU.", gpuError);
      landmarker = await createLandmarker(vision, maxFaces, "CPU");
    }
  }

  let active = false;
  let animationFrame = 0;
  let generation = 0;
  let lastVideoTime = -1;

  const stop = () => {
    active = false;
    generation += 1;
    lastVideoTime = -1;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };

  return {
    detectStart(input, callback) {
      stop();
      const video = input?.elt || input;
      if (!(video instanceof HTMLVideoElement)) {
        throw new TypeError("MediaPipe requires an HTMLVideoElement");
      }

      active = true;
      const currentGeneration = generation;
      const detect = () => {
        if (!active || currentGeneration !== generation) return;

        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          try {
            const result = landmarker.detectForVideo(video, performance.now());
            if (active && currentGeneration === generation) {
              callback(adaptResult(result));
            }
          } catch (error) {
            console.warn("MediaPipe frame detection failed", error);
          }
        }

        animationFrame = requestAnimationFrame(detect);
      };

      animationFrame = requestAnimationFrame(detect);
    },

    detectStop: stop,

    close() {
      stop();
      landmarker.close();
    }
  };
}

async function createLandmarker(vision, maxFaces, delegate) {
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate
    },
    runningMode: "VIDEO",
    numFaces: Math.max(1, Math.min(5, maxFaces)),
    minFaceDetectionConfidence: 0.45,
    minFacePresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true
  });
}

function adaptResult(result) {
  const landmarks = result?.faceLandmarks || [];
  const matrices = result?.facialTransformationMatrixes || [];

  return landmarks.slice(0, 5).map((keypoints, index) => {
    const matrix = matrices[index]?.data ? Array.from(matrices[index].data) : null;
    return {
      keypoints: keypoints.map(({ x, y, z }) => ({ x, y, z })),
      _facialTransformationMatrix: matrix,
      _pose: matrixToPose(matrix)
    };
  });
}

function matrixToPose(matrix) {
  if (!matrix || matrix.length < 16) return null;

  // MediaPipeの4x4列優先行列からXYZ回転を取り出す。
  const m11 = matrix[0];
  const m12 = matrix[4];
  const m13 = matrix[8];
  const m22 = matrix[5];
  const m23 = matrix[9];
  const m32 = matrix[6];
  const m33 = matrix[10];
  const yaw = Math.asin(clamp(m13, -1, 1));
  let pitch;
  let roll;

  if (Math.abs(m13) < 0.9999999) {
    pitch = Math.atan2(-m23, m33);
    roll = Math.atan2(-m12, m11);
  } else {
    pitch = Math.atan2(m32, m22);
    roll = 0;
  }

  const toDegrees = 180 / Math.PI;
  return {
    yaw: yaw * toDegrees,
    pitch: pitch * toDegrees,
    roll: roll * toDegrees,
    depth: matrix[14]
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
