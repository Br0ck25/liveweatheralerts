# Live Weather Alerts Vite App

This is the public React app for Live Weather Alerts. In production it talks to the worker over same-origin `/api` routes, and `VITE_API_BASE` is only needed when you want the frontend to target a different worker during local development.

## Setup

1. Install dependencies

```bash
npm install
```

2. Copy the env file

```bash
cp .env.example .env
```

3. Start the dev server

```bash
npm run dev
```

## Worker base URL override

Leave `VITE_API_BASE` unset in production builds so the app uses same-origin `/api`.

Set `VITE_API_BASE` only when the Vite dev server should talk to a separate worker origin.

Example:

```env
VITE_API_BASE=http://127.0.0.1:8787
```

## Endpoints used

- `/api/weather`
- `/api/alerts`
- `/api/geocode`
