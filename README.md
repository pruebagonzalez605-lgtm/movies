# Movie Project

This project currently runs from a single `index.html` file.

To make future changes easier, the repository now includes a cleaner structure for:

- UI code
- data sources
- external services
- styles
- static assets

## Current app entry

- `index.html`

## Suggested structure

- `src/styles/`
- `src/scripts/app.js`
- `src/scripts/config/`
- `src/scripts/data/`
- `src/scripts/services/`
- `src/scripts/ui/`
- `assets/posters/`
- `assets/icons/`
- `docs/`

## Why this helps

- Keeps movie and series data separate from rendering logic
- Makes auth, ratings, and TMDB integrations easier to maintain
- Gives you a safe place to move code gradually without rewriting everything at once

See `docs/refactor-roadmap.md` for the next migration steps.
