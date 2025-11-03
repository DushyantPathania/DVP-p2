D3 Draggable Globe

This is a minimal example of a draggable, rotatable globe using D3's geo projection (orthographic) and canvas. It is adapted from the Observable example "Draggable Globe in D3".

Files:
- `index.html` — HTML page that loads D3 and the script.
- `main.js` — Implements the canvas globe: loads world topojson, draws land, graticule, sphere, and handles drag/zoom/auto-rotate.

How to open
1. Open `e:/DVP p2/index.html` in your browser (double-click or use "Open with" from your editor).
2. Drag the globe with mouse/touch. Use the mouse wheel to zoom.

Notes
- The page fetches world topojson from unpkg: `https://unpkg.com/world-atlas@2.0.2/world/110m.json`.
- If you want offline data, download the topojson file and update the URL in `main.js`.
- This example uses D3 v7 and topojson-client from CDNs.

Customization ideas
- Color and shading tweaks.
- Draw points/cities using `context` and `path` for coordinates.
- Switch to a higher-resolution dataset (50m or custom GeoJSON).
