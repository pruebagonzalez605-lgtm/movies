# Refactor Roadmap

This repository started as a single-file movie app inside `index.html`.

The new structure added in this refinement is meant to support a gradual migration.

## Phase 1

Keep `index.html` working as-is and prepare folders:

- `src/styles` for CSS
- `src/scripts/data` for `MOVIES` and `SERIES`
- `src/scripts/services` for TMDB, Supabase, and Kick auth helpers
- `src/scripts/ui` for player and carousel rendering

## Phase 2

Move code out of `index.html` in this order:

1. Copy CSS blocks into `src/styles/theme.css` and `src/styles/layout.css`
2. Move `MOVIES` into `src/scripts/data/movies.js`
3. Move `SERIES` into `src/scripts/data/series.js`
4. Move API constants into `src/scripts/config/app-config.example.js`
5. Move helper functions into `src/scripts/services/` and `src/scripts/ui/`
6. Use `src/scripts/app.js` as the main browser entry point

## Recommended split

- `config/app-config.example.js`
  Holds API keys, base URLs, and language settings

- `services/tmdb.js`
  Poster search, TV search, season lookup, and cache helpers

- `services/supabase.js`
  REST headers, ratings, and suggestions requests

- `services/kick-auth.js`
  Login flow, redirect parsing, session storage, and logout

- `ui/player.js`
  Video selection, playback recovery, and watch progress

- `ui/carousels.js`
  Movie cards, series cards, saga cards, and episode cards

- `ui/ratings.js`
  Rating stars rendering and submission flow

- `ui/suggestions.js`
  Suggestion list rendering and form submission

## Important note

The new files are scaffolding only. The live app still uses `index.html` until you decide to migrate each section.
