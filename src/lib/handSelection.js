// Fusion Move: hand landmark based selection.
//
// The detector is loaded lazily from MediaPipe's ESM build so the main bundle stays small.
// If the remote model cannot load (offline/CSP/etc.), callers should fall back to manual or
// tap-centered selection rather than blocking the editing workflow.

const MEDIAPIPE_ESM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm';
const MEDIAPIPE_WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let detectorPromise = null;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const normalize = (v) => {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
};

const cross = (o, a, b) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

export function convexHull(points) {
  if (points.length <= 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function expandHull(points, factor, width, height) {
  const center = points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }),
    { x: 0, y: 0 }
  );
  return points.map((p) => ({
    x: Math.max(0, Math.min(width, center.x + (p.x - center.x) * factor)),
    y: Math.max(0, Math.min(height, center.y + (p.y - center.y) * factor)),
  }));
}

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await import(/* @vite-ignore */ MEDIAPIPE_ESM);
      const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      return vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL },
        runningMode: 'IMAGE',
        numHands: 4,
        minHandDetectionConfidence: 0.35,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      });
    })().catch((error) => {
      detectorPromise = null;
      throw error;
    });
  }
  return detectorPromise;
}

export async function detectHands(imageSource, width, height) {
  const detector = await getDetector();
  const result = detector.detect(imageSource);
  const hands = result?.landmarks || [];
  return hands.map((landmarks, index) => {
    const points = landmarks.map((p) => ({ x: p.x * width, y: p.y * height }));
    const center = points.reduce(
      (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }),
      { x: 0, y: 0 }
    );
    return {
      index,
      points,
      center,
      handedness: result.handednesses?.[index]?.[0]?.categoryName || null,
      score: result.handednesses?.[index]?.[0]?.score ?? null,
    };
  });
}

export function nearestHand(hands, tapPoint, maxDistance = Infinity) {
  let best = null;
  let bestDistance = Infinity;
  for (const hand of hands) {
    const d = distance(hand.center, tapPoint);
    if (d < bestDistance) {
      best = hand;
      bestDistance = d;
    }
  }
  return best && bestDistance <= maxDistance ? best : null;
}

export function handSelectionPolygon(hand, extent, width, height) {
  const p = hand.points;
  if (!p || p.length < 21) return [];

  // MediaPipe landmarks: 0 wrist, 5 index MCP, 9 middle MCP, 17 pinky MCP.
  // Use the convex hull of all hand landmarks as the base; this avoids forcing users
  // to trace fingers manually while keeping the selected area much tighter than an ellipse.
  let points = [...p];
  const wrist = p[0];
  const middleMcp = p[9];
  const indexMcp = p[5];
  const pinkyMcp = p[17];
  const palmWidth = Math.max(8, distance(indexMcp, pinkyMcp));
  const handLength = Math.max(palmWidth, distance(wrist, p[12]));
  const forearmDir = normalize({ x: wrist.x - middleMcp.x, y: wrist.y - middleMcp.y });
  const normal = { x: -forearmDir.y, y: forearmDir.x };

  if (extent === 'hand_wrist' || extent === 'hand_forearm') {
    const extension = extent === 'hand_forearm' ? handLength * 1.15 : handLength * 0.35;
    const halfWidth = palmWidth * (extent === 'hand_forearm' ? 0.5 : 0.42);
    const end = {
      x: wrist.x + forearmDir.x * extension,
      y: wrist.y + forearmDir.y * extension,
    };
    points.push(
      { x: wrist.x + normal.x * halfWidth, y: wrist.y + normal.y * halfWidth },
      { x: wrist.x - normal.x * halfWidth, y: wrist.y - normal.y * halfWidth },
      { x: end.x + normal.x * halfWidth * 0.82, y: end.y + normal.y * halfWidth * 0.82 },
      { x: end.x - normal.x * halfWidth * 0.82, y: end.y - normal.y * halfWidth * 0.82 }
    );
  }

  const hull = convexHull(points);
  const expansion = extent === 'hand' ? 1.12 : extent === 'hand_wrist' ? 1.08 : 1.05;
  return expandHull(hull, expansion, width, height);
}
