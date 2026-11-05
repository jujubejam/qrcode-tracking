const video = document.getElementById('webcam');
const cameraSelect = document.getElementById('cameraSelect');
const stage = document.getElementById('stage');
const stageCtx = stage.getContext('2d');
const statusEl = document.getElementById('status');
const detectedCodesEl = document.getElementById('detectedCodes');

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image;
}

// Only these specific physical tokens get a portal; any other code is
// tracked (for calibration/detection purposes) but shows nothing.
const PORTAL_IMAGES_BY_DATA = {
  phone: loadImage('portal_cool.png'),
  'object-a': loadImage('portal_warm.png'),
};

// Human-readable names for the same recognized characters, used for the
// on-screen nameplate, the spoken announcement, and the "X is Y" land
// readout. Key order matters: it's the order names appear in when several
// characters share a land ("JuJu and 雨轩 are doing great").
const CHARACTER_NAMES = {
  'object-a': 'JuJu',
  phone: '雨轩',
};

function hasCJK(text) {
  return /[一-鿿]/.test(text);
}

// Speaks one utterance, auto-detecting a Chinese voice for CJK text so it's
// pronounced correctly rather than mangled by an English voice. Consecutive
// speak() calls are queued by the browser and play back-to-back, which is
// used to mix a CJK name with an English phrase in a single announcement
// (see announceLand) without either part being read in the wrong voice.
function speak(text) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  if (hasCJK(text)) {
    utterance.lang = 'zh-CN';
  }
  speechSynthesis.speak(utterance);
}

// Speaks a sentence assembled from separate parts, merging neighbors of the
// same script into one utterance so e.g. ["JuJu", "and", "雨轩", "are doing
// great"] becomes "JuJu and" (English) -> "雨轩" (Chinese) -> "are doing
// great" (English), each in the right voice with as few pauses as possible.
function speakParts(parts) {
  const groups = [];
  for (const part of parts) {
    const cjk = hasCJK(part);
    const last = groups[groups.length - 1];
    if (last && last.cjk === cjk) {
      last.text += ` ${part}`;
    } else {
      groups.push({ text: part, cjk });
    }
  }
  groups.forEach((group) => speak(group.text));
}

// A character counts as having left the camera's view once it hasn't been
// seen for this long. That's longer than any brief detection flicker (the
// code dropping out of trackedTokens for just over TOKEN_PERSISTENCE_MS,
// then reappearing), which would otherwise look identical to leaving and
// coming back. Two consequences: a character that comes back after this long
// is announced by name again (re-announcing on every flicker piles up in
// speechSynthesis's queue and keeps playing after the token is gone), and a
// character gone this long is no longer in any land (see
// updateCharacterLands).
const LEFT_SCREEN_AFTER_MS = 3000;
const lastSeenAt = new Map();

// Reads a character's name aloud when its portal first appears (see the
// isNewSighting check in updateTrackedTokens).
function announceCharacter(data) {
  const name = CHARACTER_NAMES[data];
  if (name) {
    speak(name);
  }
}

// Reads "<name> is <land>" aloud once, the moment a character's land
// assignment is first set or changes (see updateCharacterLands) — not on
// every frame it stays on the same land. Split into two utterances so a
// CJK name and the English land phrase are each spoken in the right voice.
function announceLand(data, land) {
  const name = CHARACTER_NAMES[data];
  if (name) {
    speak(name);
    speak(landNamed(land).singular);
  }
}

// readBarcodes() fetches and instantiates the wasm module lazily on its
// first call, which would otherwise stall the very first real frame.
// Kicking that off immediately on load means it's ready well before the
// camera stream and first video frame are. Wrapped defensively: if this
// library fails to load or init for any reason, that must never be able to
// block camera access (an unrelated, more important concern) by throwing
// an uncaught error here.
try {
  ZXingWASM.prepareZXingModule({ fireImmediately: true });
} catch (error) {
  console.error('Failed to initialize zxing-wasm:', error);
}

let sampleCanvas;
let sampleCtx;
let tickLoopStarted = false;
let latestDetections = [];

// Token QR scanning runs on a downscaled copy of the frame rather than the
// full capture resolution, purely to cut the number of pixels zxing-wasm
// has to examine per frame. Corner-marker (ArUco) detection is unrelated
// and still runs on the full-resolution frame, unchanged.
const DETECTION_MAX_WIDTH = 1280;
let detectionCanvas;
let detectionCtx;
let detectionScale = 1;

// readBarcodes() is async and, per frame, meaningfully slower than a
// synchronous call — awaiting it inline in the render loop would stall
// rendering. Instead it's kicked off without blocking tick(), and this
// flag stops a new scan from starting while one is still in flight (so a
// slow frame can't pile up a backlog of overlapping scans).
let detectionInFlight = false;

// Rolling once-a-second readout of how often a scan actually decodes
// something, to distinguish "detection is genuinely unreliable right now"
// from other causes of a missing portal.
let scansThisWindow = 0;
let successesThisWindow = 0;
let statsWindowStart = performance.now();
const detectionRateEl = document.getElementById('detectionRate');

function recordScanResult(succeeded) {
  scansThisWindow += 1;
  if (succeeded) {
    successesThisWindow += 1;
  }

  const now = performance.now();
  if (now - statsWindowStart >= 1000) {
    detectionRateEl.textContent = `Decode rate: ${successesThisWindow}/${scansThisWindow} frames/sec`;
    scansThisWindow = 0;
    successesThisWindow = 0;
    statsWindowStart = now;
  }
}

// Decoded data is matched exactly, so incidental whitespace or casing from
// however a code was generated (e.g. "Phone " vs "phone") would otherwise
// silently fail to match anything in PORTAL_IMAGES_BY_DATA.
function normalizeData(data) {
  return (data || '').trim().toLowerCase();
}

// A code missing from one frame's scan (motion blur, a brief bad decode,
// etc.) shouldn't make its portal flicker off. Each detected code's last
// known location is kept for a grace period after it stops being seen, and
// only dropped once that expires.
const TOKEN_PERSISTENCE_MS = 400;
const trackedTokens = new Map();

function updateTrackedTokens(detections) {
  const now = performance.now();

  for (const detection of detections) {
    const data = normalizeData(detection.data);
    const isNewSighting = !trackedTokens.has(data);
    const absentMs = now - (lastSeenAt.get(data) ?? -Infinity);
    trackedTokens.set(data, { data, location: detection.location, lastSeen: now });
    lastSeenAt.set(data, now);

    if (isNewSighting && absentMs >= LEFT_SCREEN_AFTER_MS) {
      announceCharacter(data);
    }
  }

  for (const [data, token] of trackedTokens) {
    if (now - token.lastSeen > TOKEN_PERSISTENCE_MS) {
      trackedTokens.delete(data);
    }
  }

  detectedCodesEl.textContent = trackedTokens.size
    ? `Seen: ${[...trackedTokens.keys()].map((data) => `"${data}"`).join(', ')}`
    : '';
}

// Maps a point in the camera's pixel space onto the screen's pixel space, so
// a code's position as seen from above corresponds to where it physically
// sits on the display. Recomputed continuously; see updateHomography().
let homography = null;

// Fixed ArUco markers rendered at the four known screen corners. ArUco
// markers are built for exactly this: tracking-camera detection at odd
// angles, distances and lighting, which QR codes (tuned for someone holding
// a phone up close) are much less reliable at, especially stuck in the
// corner of a frame. Detecting all four in a frame gives four (camera
// position, screen position) correspondences, enough to (re)solve the
// homography, so calibration stays correct even if the camera or screen
// moves. Physical tokens placed on the display are still tracked as QR
// codes (see scanForQRCodes), since those benefit from carrying arbitrary
// data rather than just a small fixed ID.
const CORNER_MARKERS = [
  { element: document.getElementById('cornerTL'), id: 0 },
  { element: document.getElementById('cornerTR'), id: 1 },
  { element: document.getElementById('cornerBR'), id: 2 },
  { element: document.getElementById('cornerBL'), id: 3 },
];

const arDictionary = new AR.Dictionary('ARUCO_MIP_36h12');
const arDetector = new AR.Detector();

for (const marker of CORNER_MARKERS) {
  marker.element.innerHTML = arDictionary.generateSVG(marker.id);
}

// Three static status QR codes placed on the display itself. Unlike the
// corner markers (used for calibration) and tracked tokens (physical
// objects placed on the surface), these are just fixed, labeled codes shown
// on screen — e.g. for someone to scan directly with a phone.
const STATUS_MARKERS = [
  { element: document.getElementById('statusQR1'), data: 'doing great' },
  { element: document.getElementById('statusQR2'), data: 'alright' },
  { element: document.getElementById('statusQR3'), data: 'need help' },
];

for (const marker of STATUS_MARKERS) {
  const qr = qrcode(0, 'L');
  qr.addData(marker.data);
  qr.make();
  marker.element.innerHTML = qr.createSvgTag(4, 0);
}

// Each status marker has a square "land" around it (the dashed box drawn in
// CSS). A recognized character (a token with a portal image) standing in
// one is considered "on" that land.
//
// characterLands holds each character's *current* land: the land it's
// standing in, or null when it isn't in any — whether it's been moved
// outside every land (but is still visible to the camera) or taken out of
// view altogether. Announcements and "who is in this land?" are both driven
// by it, so a character that's left a land is never reported as still in it.
// `singular` and `plural` are how each land reads after a name ("JuJu needs
// help", "JuJu and 雨轩 need help").
const LANDS = [
  { element: document.getElementById('landZone1'), marker: document.querySelector('.status-marker-1'), name: 'doing great', singular: 'is doing great', plural: 'are doing great' },
  { element: document.getElementById('landZone2'), marker: document.querySelector('.status-marker-2'), name: 'alright', singular: 'is alright', plural: 'are alright' },
  { element: document.getElementById('landZone3'), marker: document.querySelector('.status-marker-3'), name: 'need help', singular: 'needs help', plural: 'need help' },
];

function landNamed(name) {
  return LANDS.find((land) => land.name === name);
}

const characterLands = new Map();
const characterLandsEl = document.getElementById('characterLands');

function elementRect(element) {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function landContaining(point) {
  for (const land of LANDS) {
    const rect = elementRect(land.element);
    if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
      return land.name;
    }
  }
  return null;
}

// Moving out of a land has to last this long before the character counts as
// out of it, so a token resting near a land's edge, jittering back and forth
// across it, doesn't keep leaving and re-entering (and re-announcing).
const OUTSIDE_LAND_AFTER_MS = 800;
const lastInLandAt = new Map();

// Re-evaluates every character's land from where it was last seen:
//  - Inside a land: that's its land. Announced when it changes (including
//    entering a land from outside, or from out of view).
//  - Visible but outside every land: no land, once it's stayed out for
//    OUTSIDE_LAND_AFTER_MS.
//  - Not visible at all: no land, once it's been gone LEFT_SCREEN_AFTER_MS.
// Ending up in no land is silent; the sentence is only for arriving somewhere.
function updateCharacterLands() {
  const now = performance.now();

  for (const data of Object.keys(CHARACTER_NAMES)) {
    const token = trackedTokens.get(data);
    const land = token && homography
      ? landContaining(applyHomography(homography, centerOf(token.location)))
      : null;
    const current = characterLands.get(data) ?? null;

    if (land) {
      lastInLandAt.set(data, now);
      if (land !== current) {
        characterLands.set(data, land);
        announceLand(data, land);
      }
    } else if (current) {
      const graceMs = token ? OUTSIDE_LAND_AFTER_MS : LEFT_SCREEN_AFTER_MS;
      if (now - lastInLandAt.get(data) >= graceMs) {
        characterLands.set(data, null);
      }
    }
  }

  characterLandsEl.textContent = [...characterLands.entries()]
    .filter(([, land]) => land)
    .map(([data, land]) => `${CHARACTER_NAMES[data]} ${landNamed(land).singular}`)
    .join('  |  ');
}

// ---------------------------------------------------------------------------
// Treadmill: the world (map and lands) is bigger than the screen. A character
// standing near any edge of the screen scrolls the world under it, revealing
// what was hidden past that edge, the way a treadmill moves the ground under
// someone walking in place. The characters themselves are physical tokens, so
// they never move on screen; only the world does.
// ---------------------------------------------------------------------------

// Lands sit this many screen widths apart, so only one is in full view at a
// time and the others are hidden off to the sides. The world is exactly wide
// enough to center each land on screen; its height follows the map's own
// proportions. Scrolling stops at the world's edges.
const LAND_SPACING_SCREENS = 0.75;
// worldmap.jpg is 2560x1707.
const MAP_ASPECT = 1707 / 2560;
// How far in from each edge (as a fraction of the screen's width or height) a
// character starts pushing the world, and how fast the world moves when a
// character is right at the edge. Deeper into the edge zone scrolls faster.
const EDGE_ZONE_FRACTION = 0.2;
const MAX_SCROLL_PX_PER_SEC = 350;

// The world point shown at the screen's top-left corner. Starts vertically
// centered, with the lands (which sit on the map's middle line) mid-screen.
const worldScroll = { x: 0, y: 0 };

function worldSize() {
  const width = window.innerWidth * (1 + (LANDS.length - 1) * LAND_SPACING_SCREENS);
  return { width, height: Math.max(window.innerHeight, width * MAP_ASPECT) };
}

function clampWorldScroll() {
  const { width, height } = worldSize();
  worldScroll.x = Math.max(0, Math.min(width - window.innerWidth, worldScroll.x));
  worldScroll.y = Math.max(0, Math.min(height - window.innerHeight, worldScroll.y));
}

function landWorldPosition(index) {
  return {
    x: window.innerWidth * (0.5 + index * LAND_SPACING_SCREENS),
    y: worldSize().height / 2,
  };
}

// -1 (fully in the near edge zone) to 1 (fully in the far one), 0 elsewhere,
// along one axis of a screen `length` long.
function edgePush(position, length) {
  const zone = length * EDGE_ZONE_FRACTION;
  if (position < zone) {
    return -Math.min(1, (zone - position) / zone);
  }
  if (position > length - zone) {
    return Math.min(1, (position - (length - zone)) / zone);
  }
  return 0;
}

// Moving the land boxes themselves (rather than only redrawing them) keeps
// each one's rendered box the single source of truth for its hit-test, so
// landContaining and pointing need no changes.
function layoutWorld() {
  LANDS.forEach((land, index) => {
    const { x, y } = landWorldPosition(index);
    for (const element of [land.element, land.marker]) {
      element.style.left = `${x - worldScroll.x}px`;
      element.style.top = `${y - worldScroll.y}px`;
    }
  });
  stage.style.backgroundSize = `${worldSize().width}px auto`;
  stage.style.backgroundPosition = `${-worldScroll.x}px ${-worldScroll.y}px`;
}

function edgePushAt(point) {
  return { x: edgePush(point.x, window.innerWidth), y: edgePush(point.y, window.innerHeight) };
}

// Characters at opposite edges cancel each other out. Returns how far the
// world actually moved, which is zero at the world's edges even while a
// character is pushing.
function updateTreadmill(dt) {
  const push = { x: 0, y: 0 };
  if (homography) {
    for (const data of Object.keys(CHARACTER_NAMES)) {
      const token = trackedTokens.get(data);
      if (token) {
        const characterPush = edgePushAt(applyHomography(homography, centerOf(token.location)));
        push.x += characterPush.x;
        push.y += characterPush.y;
      }
    }
  }

  const before = { ...worldScroll };
  const step = MAX_SCROLL_PX_PER_SEC * dt;
  worldScroll.x += Math.max(-1, Math.min(1, push.x)) * step;
  worldScroll.y += Math.max(-1, Math.min(1, push.y)) * step;
  clampWorldScroll();
  layoutWorld();
  return { x: worldScroll.x - before.x, y: worldScroll.y - before.y };
}

worldScroll.y = (worldSize().height - window.innerHeight) / 2;
layoutWorld();

function videoConstraints(deviceId) {
  return {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    audio: false,
  };
}

let currentStream;

async function startStream(deviceId) {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
  }

  currentStream = await navigator.mediaDevices.getUserMedia(videoConstraints(deviceId));
  video.srcObject = currentStream;
}

async function populateCameraOptions() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');

  cameraSelect.innerHTML = '';
  for (const camera of cameras) {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${cameraSelect.length + 1}`;
    cameraSelect.appendChild(option);
  }

  cameraSelect.value = currentStream.getVideoTracks()[0]?.getSettings().deviceId;
}

cameraSelect.addEventListener('change', () => {
  startStream(cameraSelect.value);
});

startStream()
  .then(populateCameraOptions)
  .catch((error) => {
    console.error('Unable to access camera:', error);
  });

function resizeStage() {
  stage.width = window.innerWidth;
  stage.height = window.innerHeight;
}

window.addEventListener('resize', () => {
  resizeStage();
  clampWorldScroll();
  layoutWorld();
});
resizeStage();

video.addEventListener('loadedmetadata', () => {
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = video.videoWidth;
  sampleCanvas.height = video.videoHeight;
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  detectionScale = Math.min(1, DETECTION_MAX_WIDTH / video.videoWidth);
  detectionCanvas = document.createElement('canvas');
  detectionCanvas.width = Math.round(video.videoWidth * detectionScale);
  detectionCanvas.height = Math.round(video.videoHeight * detectionScale);
  detectionCtx = detectionCanvas.getContext('2d', { willReadFrequently: true });

  if (!tickLoopStarted) {
    tickLoopStarted = true;
    requestAnimationFrame(tick);
  }
});

let lastFrameAt = null;

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const frame = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
    updateHomography(frame);

    // Fire-and-forget: scanForQRCodes() is async, and this loop shouldn't
    // stall waiting on it. Rendering (below) always uses whatever the most
    // recently completed scan found.
    scanForQRCodes();
    detectPointing();

    // Capped so a stalled frame (e.g. the tab was hidden) can't jump the
    // world or the animations.
    const now = performance.now();
    const dt = lastFrameAt === null ? 0 : Math.min(0.1, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    const scrolled = updateTreadmill(dt);
    updateCharacters(dt, scrolled);
    updatePairs(now, dt);
    document.body.classList.toggle('waiting', !Object.keys(CHARACTER_NAMES).some((data) => trackedTokens.has(data)));
    renderStage(now);
  }

  requestAnimationFrame(tick);
}

// Looks for all four corner markers in the current frame and, if all are
// found, (re)solves the homography from their known screen positions and
// detected camera positions. If any are missing this frame (temporarily
// occluded, out of view, etc.), the previous homography is kept as-is.
function updateHomography(frame) {
  const arMarkers = arDetector.detect(frame);
  const correspondences = [];

  for (const marker of CORNER_MARKERS) {
    // hammingDistance is 0 only for an exact bit-for-bit match. A nonzero
    // distance means the read was corrupted (e.g. by glare) and the library
    // guessed the closest known code — which can be flat-out wrong, so
    // those are treated the same as not seeing the marker at all rather than
    // risking a bad point in the homography.
    const detected = arMarkers.find((m) => m.id === marker.id && m.hammingDistance === 0);
    marker.element.classList.toggle('detected', !!detected);

    if (detected) {
      correspondences.push({
        camera: averageOf(detected.corners),
        screen: elementCenter(marker.element),
      });
    }
  }

  if (correspondences.length < CORNER_MARKERS.length) {
    const seen = `${correspondences.length}/${CORNER_MARKERS.length} corners seen`;
    statusEl.textContent = homography ? `Tracking (last calibration, ${seen})` : `Calibrating… (${seen})`;
    return;
  }

  homography = computeHomography(correspondences);
  statusEl.textContent = 'Tracking';
}

function elementCenter(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function averageOf(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

// ---------------------------------------------------------------------------
// Position and movement: what each character's place on the monitor, and how
// it's moving relative to the lands and to the other characters, does.
//  - Into / out of the monitor: the portal pops open, or shrinks closed.
//  - At the rim: the world moves like a treadmill and the portal blinks, since
//    the token itself stands still.
//  - Toward / away from "need help": a black poisonous aura with pirate flags
//    gathers while a character approaches, and fades as it walks away.
//  - Toward / away from each other: a blinking bond builds between two
//    characters, and turns into bestie mode once they're adjacent.
// ---------------------------------------------------------------------------

// A portal takes 1 / this many seconds to fully open or close.
const PORTAL_OPEN_PER_SEC = 3;

// How far past the "need help" box (as a fraction of the box's width) the
// poison starts to reach a character walking toward it.
const POISON_REACH = 0.8;
const POISON_RISE_PER_SEC = 0.8;
const POISON_FADE_PER_SEC = 0.5;

// Distances between characters are measured in code widths, so they mean the
// same thing however high the camera is. Adjacent means no other token could
// fit between them: centers under two code widths apart leaves a gap smaller
// than one code. Once adjacent, they have to drift a little further apart to
// stop counting, so jitter at the threshold can't flicker bestie mode.
const ADJACENT_CODES = 2;
const ADJACENT_RELEASE_CODES = 2.4;
// The bond starts building within this many code widths.
const BOND_RANGE_CODES = 8;
// Faster than this (in code widths, or pixels for the "need help" box, per
// second) counts as moving toward or away; slower is detection jitter.
const TREND_CODES_PER_SEC = 0.6;
const TREND_PX_PER_SEC = 40;
const BOND_RISE_PER_SEC = 1.5;
const BOND_DRAIN_PER_SEC = 0.8;
// Bestie mode outlasts brief detection dropouts, like OUTSIDE_LAND_AFTER_MS.
const BESTIE_ENDS_AFTER_MS = 800;

const characterStates = new Map();
const pairStates = new Map();

function approach(value, target, maxStep) {
  return value < target ? Math.min(target, value + maxStep) : Math.max(target, value - maxStep);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// "toward" when the distance is shrinking faster than `threshold`, "away"
// when it is growing that fast, otherwise "still" (jitter).
function trendOf(rate, threshold) {
  if (rate < -threshold) {
    return 'toward';
  }
  return rate > threshold ? 'away' : 'still';
}

// Smooths a jittery distance and its rate of change. `track` holds both
// between frames.
function trackDistance(track, raw, dt) {
  if (track.distance === null) {
    track.distance = raw;
    track.rate = 0;
    return;
  }
  const previous = track.distance;
  track.distance += (raw - previous) * Math.min(1, dt * 8);
  if (dt > 0) {
    track.rate += ((track.distance - previous) / dt - track.rate) * Math.min(1, dt * 4);
  }
}

// Where a code's portal and name sit on screen, from its corners.
function characterGeometry(location) {
  const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = location;
  const center = applyHomography(homography, centerOf(location));
  const topLeft = applyHomography(homography, topLeftCorner);
  const topRight = applyHomography(homography, topRightCorner);
  const bottomLeft = applyHomography(homography, bottomLeftCorner);
  const bottomRight = applyHomography(homography, bottomRightCorner);

  const radius = Math.hypot(topLeft.x - center.x, topLeft.y - center.y) * 1.3 * 2;

  // "Up" in the code's own orientation (from its bottom edge toward its
  // top edge) rather than screen-space up, so the offset stays centered
  // over the code even when it's rotated rather than drifting sideways.
  const codeWidth = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const codeHeight = Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y);
  const upX = (topLeft.x - bottomLeft.x) / codeHeight;
  const upY = (topLeft.y - bottomLeft.y) / codeHeight;

  const offset = codeWidth * 0.5;
  const portalCenter = {
    x: (topLeft.x + topRight.x) / 2 + upX * offset,
    y: (topLeft.y + topRight.y) / 2 + upY * offset,
  };

  // Below the code's own bottom edge (opposite side from the portal, which
  // floats above its top edge), so the two don't overlap.
  const namePosition = {
    x: (bottomLeft.x + bottomRight.x) / 2 - upX * 24,
    y: (bottomLeft.y + bottomRight.y) / 2 - upY * 24,
  };

  return { center, portalCenter, radius, namePosition, codeSize: codeWidth };
}

function distanceToRect(point, rect) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

// A character's last geometry is kept after it leaves, so its portal can
// close where it was.
function updateCharacters(dt, scrolled) {
  const needHelpRect = elementRect(landNamed('need help').element);

  for (const data of Object.keys(CHARACTER_NAMES)) {
    const token = homography ? trackedTokens.get(data) : null;
    let state = characterStates.get(data);
    if (!state) {
      state = { geometry: null, present: false, open: 0, pushing: 0, poison: 0, help: { distance: null, rate: 0 }, helpReach: 0 };
      characterStates.set(data, state);
    }

    state.present = !!token;
    state.open = approach(state.open, state.present ? 1 : 0, PORTAL_OPEN_PER_SEC * dt);
    if (!state.present) {
      state.pushing = 0;
      state.help.distance = null;
      state.poison = approach(state.poison, 0, POISON_FADE_PER_SEC * dt);
      continue;
    }
    state.geometry = characterGeometry(token.location);
    const { center } = state.geometry;

    // How hard it pushes the treadmill, counted only along an axis the world
    // actually moved in that direction.
    const push = edgePushAt(center);
    const along = (p, moved) => (moved !== 0 && Math.sign(p) === Math.sign(moved) ? Math.abs(p) : 0);
    state.pushing = Math.max(along(push.x, scrolled.x), along(push.y, scrolled.y));

    // The treadmill moving the box toward a character counts as walking
    // toward it, which is what it is in the world.
    const reach = (needHelpRect.right - needHelpRect.left) * POISON_REACH;
    const rawDistance = distanceToRect(center, needHelpRect);
    trackDistance(state.help, rawDistance, dt);
    state.helpReach = clamp01(1 - state.help.distance / reach);

    let target = state.poison;
    if (rawDistance === 0) {
      target = 1;
    } else {
      const trend = trendOf(state.help.rate, TREND_PX_PER_SEC);
      if (trend === 'toward') {
        target = Math.max(state.poison, state.helpReach);
      } else if (trend === 'away') {
        target = 0;
      }
      // Standing still holds the poison, but never more than its reach, so
      // it's gone once a character is out of range.
      target = Math.min(target, state.helpReach);
    }
    const rate = target > state.poison ? POISON_RISE_PER_SEC : POISON_FADE_PER_SEC;
    state.poison = approach(state.poison, target, rate * dt);
  }
}

function updatePairs(now, dt) {
  const keys = Object.keys(CHARACTER_NAMES);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const [a, b] = [keys[i], keys[j]];
      const key = `${a}|${b}`;
      let pair = pairStates.get(key);
      if (!pair) {
        pair = { a, b, distance: null, rate: 0, trend: 'still', charge: 0, bestie: false, lastAdjacentAt: -Infinity };
        pairStates.set(key, pair);
      }

      const stateA = characterStates.get(a);
      const stateB = characterStates.get(b);
      const together = stateA.present && stateB.present;
      let adjacent = false;
      let closeness = 0;

      if (together) {
        const { center: ca, codeSize: sa } = stateA.geometry;
        const { center: cb, codeSize: sb } = stateB.geometry;
        trackDistance(pair, Math.hypot(ca.x - cb.x, ca.y - cb.y) / ((sa + sb) / 2), dt);
        pair.trend = trendOf(pair.rate, TREND_CODES_PER_SEC);
        adjacent = pair.distance < (pair.bestie ? ADJACENT_RELEASE_CODES : ADJACENT_CODES);
        closeness = clamp01(1 - (pair.distance - ADJACENT_CODES) / (BOND_RANGE_CODES - ADJACENT_CODES));
      } else {
        pair.distance = null;
        pair.trend = 'still';
      }

      if (adjacent) {
        pair.charge = 1;
        pair.lastAdjacentAt = now;
        if (!pair.bestie) {
          pair.bestie = true;
          speakParts([CHARACTER_NAMES[a], 'and', CHARACTER_NAMES[b], 'are besties']);
        }
      } else {
        if (pair.trend === 'toward') {
          pair.charge = approach(pair.charge, Math.max(pair.charge, closeness), BOND_RISE_PER_SEC * dt);
        } else if (pair.trend === 'away' || !together) {
          pair.charge = approach(pair.charge, 0, BOND_DRAIN_PER_SEC * dt);
        }
        if (pair.bestie && now - pair.lastAdjacentAt > BESTIE_ENDS_AFTER_MS) {
          pair.bestie = false;
        }
      }
    }
  }
}

function renderStage(now) {
  stageCtx.clearRect(0, 0, stage.width, stage.height);

  if (!homography) {
    return;
  }

  const t = now / 1000;
  for (const pair of pairStates.values()) {
    drawBond(pair, t);
  }

  for (const [data, state] of characterStates) {
    if (state.geometry && state.open > 0) {
      drawCharacter(data, state, t);
    }
  }

  if (fingertip && performance.now() - fingertip.seenAt < POINT_GRACE_MS) {
    drawFingertip(fingertip);
  }
}

function easeOutBack(x) {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

function drawCharacter(data, state, t) {
  const { portalCenter, radius, namePosition } = state.geometry;
  const poison = state.poison * state.open;

  if (poison > 0.01) {
    drawPoisonAura(portalCenter, radius, poison, t);
  }

  // Pushing the treadmill blinks the portal, faster the deeper into the rim.
  let alpha = state.open;
  if (state.pushing > 0) {
    alpha *= 1 - 0.45 * state.pushing * (0.5 + 0.5 * Math.sin(t * (8 + 8 * state.pushing)));
  }
  const portalImage = PORTAL_IMAGES_BY_DATA[data];
  if (portalImage) {
    drawPortal(portalImage, portalCenter, radius * Math.max(0, easeOutBack(state.open)), alpha);
  }
  if (state.open < 1) {
    drawPortalRing(portalCenter, radius, state.open);
  }

  if (poison > 0.01) {
    drawPirateFlags(portalCenter, radius, poison, t);
  }

  drawCharacterName(CHARACTER_NAMES[data], namePosition, state.open);
}

function drawCharacterName(name, position, alpha) {
  stageCtx.save();
  stageCtx.globalAlpha = alpha;
  stageCtx.font = 'bold 22px monospace';
  stageCtx.textAlign = 'center';
  stageCtx.textBaseline = 'middle';
  stageCtx.lineWidth = 5;
  stageCtx.strokeStyle = '#000';
  stageCtx.strokeText(name, position.x, position.y);
  stageCtx.fillStyle = '#F5E2BA';
  stageCtx.fillText(name, position.x, position.y);
  stageCtx.restore();
}

// Sized bigger than the code itself so it shows through around its edges,
// rather than a hard-edged shape.
function drawPortal(image, center, radius, alpha) {
  if (!image.complete) {
    return;
  }

  stageCtx.save();
  stageCtx.globalAlpha = alpha;
  const size = radius * 2;
  stageCtx.drawImage(image, center.x - radius, center.y - radius, size, size);
  stageCtx.restore();
}

// A ring that spreads out as a portal opens and closes in as it shuts,
// brightest halfway.
function drawPortalRing(center, radius, open) {
  stageCtx.save();
  stageCtx.globalAlpha = Math.sin(open * Math.PI) * 0.9;
  stageCtx.strokeStyle = '#F5E2BA';
  stageCtx.lineWidth = 3;
  stageCtx.beginPath();
  stageCtx.arc(center.x, center.y, radius * (0.5 + open * 0.7), 0, Math.PI * 2);
  stageCtx.stroke();
  stageCtx.restore();
}

function drawPoisonAura(center, radius, level, t) {
  const r = radius * (1.1 + 0.6 * level) * (1 + 0.06 * Math.sin(t * 3));
  const gradient = stageCtx.createRadialGradient(center.x, center.y, r * 0.2, center.x, center.y, r);
  gradient.addColorStop(0, `rgba(5, 0, 10, ${0.9 * level})`);
  gradient.addColorStop(0.55, `rgba(30, 0, 40, ${0.65 * level})`);
  gradient.addColorStop(0.8, `rgba(40, 90, 20, ${0.3 * level})`);
  gradient.addColorStop(1, 'rgba(40, 90, 20, 0)');

  stageCtx.save();
  stageCtx.fillStyle = gradient;
  stageCtx.beginPath();
  stageCtx.arc(center.x, center.y, r, 0, Math.PI * 2);
  stageCtx.fill();
  stageCtx.restore();
}

// More flags, bigger, the stronger the poison.
function drawPirateFlags(center, radius, level, t) {
  const count = Math.max(1, Math.round(level * 6));
  const orbit = radius * (1 + 0.4 * level);

  stageCtx.save();
  stageCtx.globalAlpha = Math.min(1, level * 1.5);
  stageCtx.font = `${Math.round(22 + 10 * level)}px sans-serif`;
  stageCtx.textAlign = 'center';
  stageCtx.textBaseline = 'middle';
  for (let i = 0; i < count; i += 1) {
    const angle = t * 0.8 + (i * Math.PI * 2) / count;
    const x = center.x + Math.cos(angle) * orbit;
    const y = center.y + Math.sin(angle) * orbit * 0.9 + Math.sin(t * 3 + i) * 4;
    stageCtx.fillText('🏴‍☠️', x, y);
  }
  stageCtx.restore();
}

// The bond between two characters: a sparkling bestie aura around both, a
// blinking gold bond (and a dashed preview of the aura) while they come
// together, or a grey bond fading as they part.
function drawBond(pair, t) {
  const stateA = characterStates.get(pair.a);
  const stateB = characterStates.get(pair.b);
  if (!stateA.present || !stateB.present) {
    return;
  }
  const a = stateA.geometry.portalCenter;
  const b = stateB.geometry.portalCenter;
  const radius = (stateA.geometry.radius + stateB.geometry.radius) / 2;

  if (pair.bestie) {
    drawBestieAura(a, b, radius, t);
    return;
  }
  if (pair.charge < 0.02) {
    return;
  }

  stageCtx.save();
  stageCtx.lineWidth = 4;
  stageCtx.lineCap = 'round';
  if (pair.trend === 'away') {
    stageCtx.globalAlpha = pair.charge * 0.7;
    stageCtx.strokeStyle = '#b8b8c4';
    stageCtx.setLineDash([4, 14]);
  } else {
    // Blinks faster as the bond nears bestie mode.
    const blink = 0.5 + 0.5 * Math.sin(t * (5 + 10 * pair.charge));
    stageCtx.globalAlpha = pair.charge * (0.4 + 0.6 * blink);
    stageCtx.strokeStyle = '#ffd76a';
    stageCtx.setLineDash([2, 10]);
    drawAuraOutline(a, b, radius);
  }
  stageCtx.beginPath();
  stageCtx.moveTo(a.x, a.y);
  stageCtx.lineTo(b.x, b.y);
  stageCtx.stroke();
  stageCtx.restore();
}

// The ellipse around two portals that the bestie aura fills.
function auraShape(a, b, radius) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    rx: Math.hypot(b.x - a.x, b.y - a.y) / 2 + radius * 0.95,
    ry: radius * 1.05,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

function drawAuraOutline(a, b, radius) {
  const { x, y, rx, ry, angle } = auraShape(a, b, radius);
  stageCtx.beginPath();
  stageCtx.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2);
  stageCtx.stroke();
}

function drawBestieAura(a, b, radius, t) {
  const { x, y, rx, ry, angle } = auraShape(a, b, radius);

  stageCtx.save();
  stageCtx.translate(x, y);
  stageCtx.rotate(angle);

  stageCtx.save();
  stageCtx.scale(1, ry / rx);
  const glow = stageCtx.createRadialGradient(0, 0, 0, 0, 0, rx);
  glow.addColorStop(0.55, 'rgba(255, 215, 120, 0)');
  glow.addColorStop(0.9, 'rgba(255, 190, 230, 0.35)');
  glow.addColorStop(1, 'rgba(255, 190, 230, 0)');
  stageCtx.fillStyle = glow;
  stageCtx.beginPath();
  stageCtx.arc(0, 0, rx, 0, Math.PI * 2);
  stageCtx.fill();
  stageCtx.restore();

  stageCtx.lineWidth = 4;
  stageCtx.strokeStyle = 'rgba(255, 225, 140, 0.9)';
  stageCtx.shadowColor = '#ffd76a';
  stageCtx.shadowBlur = 18;
  stageCtx.beginPath();
  stageCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  stageCtx.stroke();

  stageCtx.fillStyle = '#fff6d0';
  for (let i = 0; i < 16; i += 1) {
    const around = (i * Math.PI * 2) / 16 + t * 0.6;
    const size = 5 + 5 * (0.5 + 0.5 * Math.sin(t * 6 + i * 1.7));
    drawSparkle(Math.cos(around) * rx, Math.sin(around) * ry, size);
  }
  stageCtx.restore();

  stageCtx.save();
  stageCtx.font = 'bold 22px monospace';
  stageCtx.textAlign = 'center';
  stageCtx.textBaseline = 'middle';
  stageCtx.lineWidth = 5;
  stageCtx.strokeStyle = '#000';
  stageCtx.fillStyle = '#ffd76a';
  stageCtx.strokeText('besties', x, y - radius * 1.25);
  stageCtx.fillText('besties', x, y - radius * 1.25);
  stageCtx.restore();
}

// A four-pointed twinkle.
function drawSparkle(x, y, size) {
  stageCtx.beginPath();
  stageCtx.moveTo(x, y - size);
  stageCtx.quadraticCurveTo(x, y, x + size, y);
  stageCtx.quadraticCurveTo(x, y, x, y + size);
  stageCtx.quadraticCurveTo(x, y, x - size, y);
  stageCtx.quadraticCurveTo(x, y, x, y - size);
  stageCtx.fill();
}

// Solves for a homography (a 3x3 projective transform, with h33 fixed to 1)
// that maps each point's `camera` coordinates onto its `screen` coordinates,
// given the four corner-marker correspondences for this frame.
function computeHomography(points) {
  const A = [];
  const b = [];

  for (const { camera, screen } of points) {
    const { x, y } = camera;
    A.push([x, y, 1, 0, 0, 0, -x * screen.x, -y * screen.x]);
    b.push(screen.x);
    A.push([0, 0, 0, x, y, 1, -x * screen.y, -y * screen.y]);
    b.push(screen.y);
  }

  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(A, b);
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1];
}

function applyHomography(h, point) {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = h;
  const w = h31 * point.x + h32 * point.y + h33;
  return {
    x: (h11 * point.x + h12 * point.y + h13) / w,
    y: (h21 * point.x + h22 * point.y + h23) / w,
  };
}

// Solves the linear system A * x = b via Gaussian elimination with partial
// pivoting.
function solveLinearSystem(A, b) {
  const n = A.length;
  const rows = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivotRow][col])) {
        pivotRow = row;
      }
    }
    [rows[col], rows[pivotRow]] = [rows[pivotRow], rows[col]];

    for (let row = col + 1; row < n; row += 1) {
      const factor = rows[row][col] / rows[col][col];
      for (let c = col; c <= n; c += 1) {
        rows[row][c] -= factor * rows[col][c];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = rows[row][n];
    for (let col = row + 1; col < n; col += 1) {
      sum -= rows[row][col] * x[col];
    }
    x[row] = sum / rows[row][row];
  }

  return x;
}

// Decodes every QR code in the current frame in one call (zxing-wasm scans
// the whole image natively, unlike jsQR which only ever returns a single
// symbol per call and previously had to be run across a manual grid of
// overlapping crops to find more than one code). Async and fire-and-forget;
// see the detectionInFlight note above.
const ZXING_READ_OPTIONS = { formats: ['QRCode'], tryHarder: false, maxNumberOfSymbols: 10 };

async function scanForQRCodes() {
  if (detectionInFlight) {
    return;
  }
  detectionInFlight = true;

  try {
    detectionCtx.drawImage(video, 0, 0, detectionCanvas.width, detectionCanvas.height);
    const frame = detectionCtx.getImageData(0, 0, detectionCanvas.width, detectionCanvas.height);
    const results = await ZXingWASM.readBarcodes(frame, ZXING_READ_OPTIONS);

    latestDetections = results.map(scaleUpToFullRes);
    recordScanResult(latestDetections.length > 0);
    updateTrackedTokens(latestDetections.filter((detection) => isOnMonitor(detection.location)));
    updateCharacterLands();
  } catch (error) {
    console.error('QR decode failed:', error);
  } finally {
    detectionInFlight = false;
  }
}

// Converts a zxing-wasm result (text + 4-corner position, in
// detection-canvas pixel space) into this app's internal detection shape,
// scaled up to full-resolution camera-space coordinates so positions line
// up with the homography, which is built from full-resolution corner
// detections.
function scaleUpToFullRes(result) {
  const scale = (point) => ({ x: point.x / detectionScale, y: point.y / detectionScale });
  const { topLeft, topRight, bottomRight, bottomLeft } = result.position;

  return {
    data: result.text,
    location: {
      topLeftCorner: scale(topLeft),
      topRightCorner: scale(topRight),
      bottomRightCorner: scale(bottomRight),
      bottomLeftCorner: scale(bottomLeft),
    },
  };
}

function centerOf(location) {
  const { topLeftCorner, bottomRightCorner } = location;
  return {
    x: (topLeftCorner.x + bottomRightCorner.x) / 2,
    y: (topLeftCorner.y + bottomRightCorner.y) / 2,
  };
}

// The camera sees the whole table, not just the monitor. A code counts as on
// the monitor while any part of it is within the outer edges of the corner
// markers. One entirely past them is dropped before tracking, as if it
// weren't there: no portal, no name, no land, no treadmill.
function monitorBounds() {
  const topLeft = CORNER_MARKERS[0].element.getBoundingClientRect();
  const bottomRight = CORNER_MARKERS[2].element.getBoundingClientRect();
  return { left: topLeft.left, top: topLeft.top, right: bottomRight.right, bottom: bottomRight.bottom };
}

function isOnMonitor(location) {
  if (!homography) {
    return false;
  }
  const bounds = monitorBounds();
  return Object.values(location).some((corner) => {
    const { x, y } = applyHomography(homography, corner);
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  });
}

// ---------------------------------------------------------------------------
// Hand pointing: pointing at a land with an index finger announces who is in
// it, e.g. "JuJu is doing great", "no one needs help", "JuJu and 雨轩 are
// doing great".
// ---------------------------------------------------------------------------

const MEDIAPIPE_VERSION = '1.1.0';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Hand detection is comparatively expensive, so it runs a few times a
// second rather than on every frame.
const HAND_DETECT_INTERVAL_MS = 80;
// The fingertip has to stay on one land this long before it counts as
// pointing at it, so a hand sweeping across the display doesn't announce
// every land it passes over. A brief dropout (a missed frame) doesn't reset
// the timer.
const POINT_HOLD_MS = 700;
const POINT_GRACE_MS = 350;
const POINT_ANSWER_DISPLAY_MS = 6000;

const handStatusEl = document.getElementById('handStatus');
const pointingAnswerEl = document.getElementById('pointingAnswer');

let handLandmarker = null;
let lastHandDetectAt = 0;
let fingertip = null;
let pointState = null;
let pointingAnswerTimer = null;

// MediaPipe hand landmark indices: the wrist is 0, and each finger is
// [knuckle, middle joint (pip), tip].
const INDEX_FINGER = [5, 6, 8];
const OTHER_FINGERS = [[9, 10, 12], [13, 14, 16], [17, 18, 20]];
const INDEX_TIP = 8;

// A finger counts as extended when its tip is clearly farther from the wrist
// than its middle joint is, and curled when the tip has folded back closer.
// Comparing distances from the wrist (rather than looking at up/down) makes
// this work however the hand is rotated, e.g. seen from above.
const EXTENDED_RATIO = 1.1;
const CURLED_RATIO = 0.9;

function fingerReach(points, finger) {
  const [, pip, tip] = finger;
  const wrist = points[0];
  const dist = (i) => Math.hypot(points[i].x - wrist.x, points[i].y - wrist.y);
  return dist(tip) / dist(pip);
}

// `points` are the 21 hand landmarks in pixel space. Pointing means the
// index finger is out while the middle finger is folded away and at least
// one of the ring/pinky is too (which rules out an open hand, a peace sign
// and a raised middle finger).
function isPointingGesture(points) {
  if (fingerReach(points, INDEX_FINGER) < EXTENDED_RATIO) {
    return false;
  }

  const [middle, ...ringAndPinky] = OTHER_FINGERS.map((finger) => fingerReach(points, finger));
  return middle < CURLED_RATIO && ringAndPinky.some((reach) => reach < CURLED_RATIO);
}

// Characters currently in `land`, in CHARACTER_NAMES order.
function namesInLand(land) {
  return Object.keys(CHARACTER_NAMES)
    .filter((data) => characterLands.get(data) === land)
    .map((data) => CHARACTER_NAMES[data]);
}

// The answer to "who is in this land?" as separate parts, so it can be shown
// as text and spoken with each part in the right voice (see speakParts).
function whoIsInParts(land) {
  const names = namesInLand(land);
  const { singular, plural } = landNamed(land);
  if (names.length === 0) {
    return ['no one', singular];
  }

  const parts = [];
  names.forEach((name, i) => {
    if (i > 0) {
      parts.push('and');
    }
    parts.push(name);
  });
  parts.push(names.length === 1 ? singular : plural);
  return parts;
}

function announceWhoIsIn(land) {
  const parts = whoIsInParts(land);

  pointingAnswerEl.textContent = parts.join(' ');
  clearTimeout(pointingAnswerTimer);
  pointingAnswerTimer = setTimeout(() => {
    pointingAnswerEl.textContent = '';
  }, POINT_ANSWER_DISPLAY_MS);

  speakParts(parts);
}

// Tracks which land is being pointed at and announces it once the fingertip
// has rested there for POINT_HOLD_MS. Pointing at a land again (after
// moving away from it, or to another land) announces again.
function updatePointState(land, now) {
  if (land) {
    if (!pointState || pointState.land !== land) {
      pointState = { land, since: now, lastSeen: now, announced: false };
    } else {
      pointState.lastSeen = now;
    }

    if (!pointState.announced && now - pointState.since >= POINT_HOLD_MS) {
      pointState.announced = true;
      announceWhoIsIn(land);
    }
  } else if (pointState && now - pointState.lastSeen > POINT_GRACE_MS) {
    pointState = null;
  }

  const active = pointState ? pointState.land : null;
  for (const l of LANDS) {
    l.element.classList.toggle('pointed', l.name === active);
  }
}

function detectPointing() {
  if (!handLandmarker || !homography) {
    return;
  }

  const now = performance.now();
  if (now - lastHandDetectAt < HAND_DETECT_INTERVAL_MS) {
    return;
  }
  lastHandDetectAt = now;

  try {
    const landmarks = handLandmarker.detectForVideo(video, now).landmarks[0];
    let tip = null;
    let status = 'none';

    if (landmarks) {
      // Landmarks are normalized to the frame; scale to the same full-
      // resolution camera space the homography was built in.
      const points = landmarks.map((p) => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight }));
      status = 'seen (not pointing)';

      if (isPointingGesture(points)) {
        tip = applyHomography(homography, points[INDEX_TIP]);
        fingertip = { ...tip, seenAt: now };
      }
    }

    const land = tip ? landContaining(tip) : null;
    updatePointState(land, now);

    if (tip) {
      status = `pointing at ${land || 'no land'}`;
    }
    handStatusEl.textContent = `Hand: ${status}`;
  } catch (error) {
    console.error('Hand detection failed:', error);
    handStatusEl.textContent = 'Hand: unavailable';
    handLandmarker = null;
  }
}

function drawFingertip(point) {
  stageCtx.save();
  stageCtx.beginPath();
  stageCtx.arc(point.x, point.y, 14, 0, Math.PI * 2);
  stageCtx.fillStyle = '#F5E2BA';
  stageCtx.fill();
  stageCtx.lineWidth = 4;
  stageCtx.strokeStyle = '#000';
  stageCtx.stroke();
  stageCtx.restore();
}

// MediaPipe is loaded on demand (it's an ES module, and not needed until a
// hand is in view). Failing to load it must never affect the camera or
// token tracking, so any error is just reported in the status line.
async function initHandLandmarker() {
  handStatusEl.textContent = 'Hand: loading…';

  const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
  const { FilesetResolver, HandLandmarker } = await import(`${base}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);

  const create = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
  });

  try {
    handLandmarker = await create('GPU');
  } catch (gpuError) {
    handLandmarker = await create('CPU');
  }
  handStatusEl.textContent = 'Hand: ready';
}

initHandLandmarker().catch((error) => {
  console.error('Hand detection unavailable:', error);
  handStatusEl.textContent = 'Hand: unavailable';
});
