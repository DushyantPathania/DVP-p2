# DVP-p2

## Quick start — open the project

Open `index.html` in your web browser (double-click the file or choose "Open File...").

For a more robust local testing environment (recommended, since the app loads CSV files), serve the folder with a local web server. From PowerShell you can run:

```powershell
python -m http.server 8000
# then open http://localhost:8000/index.html
```

Or use VS Code Live Server extension to serve the project and open the page automatically.

## What this project is

This is a small client-side data visualization project that renders cricket venue-related maps and statistics from CSV datasets. It uses only static files (HTML, CSS, JavaScript) and CSV data found in the `data/csvs/` folder.

Key files:

- `index.html` — main page; open this to run the app.
- `map.js` — map rendering and interaction logic.
- `venue.js`, `venue-worker.js` — venue-specific behavior and worker logic.
- `db.js` — CSV loading and data utilities.
- `styles.css` — basic styling.
- `data/csvs/` — CSV datasets (matches, innings, venues, venue_stats, etc.).

## Notes

- No build step or external dependencies are required; the app runs as static files in the browser.
- If data fails to load when opening via the `file://` protocol, use a local server as described above to avoid CORS/file access issues.
