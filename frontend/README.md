# Live Weather Alerts Vite App

This is a Vite + React + TypeScript version of the weather app UI, wired to your worker.

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

## Worker base URL

Set `VITE_API_BASE` to your worker origin.

Example:

```env
VITE_API_BASE=https://live-weather.jamesbrock25.workers.dev
```

## Endpoints used

- `/api/weather`
- `/api/alerts`
- `/api/radar`
- `/api/geocode`
