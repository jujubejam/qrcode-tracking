# Tracking project

A single-page web application for experimenting with computer vision tracking algorithms.

## Application requirements

- Make this project a simple single-page web application.
- Use vanilla javascript.

## Workflow requirements

- Assume others are working on this repository, so always get a fresh copy of the "main" branch as the source of truth for new work and new PRs.
- After a new batch of work, create a new PR into the "main" branch for this work.
- Never update old PRs after they have been merged.
- Allow the human user to review each new PR and merge it manually.
- The main branch is deployed to a github pages site. Note this URL with each PR.

## Testing and deploy (how the owner works)

- Never open `index.html` in Claude's built-in browser. The owner will not grant it camera access and tests everything in Safari via the Netlify link. `file://` also fails (Safari denies camera outside https/localhost).
- Verify without the page: run the real `script.js` in Node with stubbed browser APIs (a vm harness), test pure logic with Node, and use throwaway pages outside the project folder for library checks (MediaPipe, zxing on real photos). Say clearly what could not be tested (camera, audio, real-world feel) and ask the owner to check it in Safari.
- Flow: feature branch, then PR into `main`. The owner merges (or asks Claude to when they say "let's deploy"). Netlify auto-deploys `main`.

## Design decisions the code does not explain

The project recreates the ArUcoTUI paper (TEI '26, DOI 10.1145/3731459.3779317): a laptop screen laid flat, an iPhone (Continuity Camera, Safari) overhead, tracked QR "characters" on the screen.

- 4 ArUco markers (js-aruco2) at the screen corners calibrate a camera-to-screen homography every frame. Tokens stay QR (zxing-wasm) so they can carry data. jsQR and QR corner markers were dropped because they were unreliable overhead and at angles. Raising the Hamming tolerance and a global Otsu threshold did not help against glare, so only exact (distance 0) ArUco reads are trusted.
- Three "lands" (doing great / alright / need help) are CSS boxes; the same rendered box is both the visual and the hit-test. Each character's last known land is remembered even when out of view.
- Characters: QR text `object-a` is JuJu (warm portal), `phone` is 雨轩 (cool portal). Chinese and English are spoken as separate utterances so each uses the right voice.
- Announcements: "<name> is <land>" only when the land changes; the name alone only after 3s or more of absence (detection flickers, and speechSynthesis queues every call). Pointing with the index finger (MediaPipe hand landmarker) answers "who is in <land>".
- Do not reintroduce short cooldowns or per-frame announcements, and do not swap detectors without re-checking the overhead-camera case.
- Only codes with some part inside the outer edges of the corner markers count. The camera also sees the table around the laptop, and tokens resting there used to drive the treadmill. Off-monitor codes are filtered out before tracking, so every feature ignores them. No character on the monitor means waiting mode.
- Position and movement (a class assignment: prepositions of place and movement). Into / out of the monitor opens and closes the portal; the rim moves the treadmill and blinks the portal, since the token itself stays put; toward / away from "need help" gathers or fades a poison aura; toward / away from each other builds or drains a bond that becomes bestie mode when adjacent. Adjacent means centers under two code widths apart: no room for another token between them. JuJu has the heal skill (`CHARACTER_SKILLS`) and cures a poisoned character it stands next to.
- Movement is read from smoothed distances with a speed threshold, so detection jitter counts as standing still. Bestie mode has a release distance and an 800 ms grace, like the lands, so it is announced once rather than flickering.
