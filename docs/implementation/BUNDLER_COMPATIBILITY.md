# Web bundler compatibility

The web app keeps NodeNext `.js` import specifiers. Some internal imports point
to TypeScript source files, so the app's Webpack `extensionAlias` maps `.js`
specifiers to `.ts`, `.tsx`, or `.js` files during bundling.

Next.js 16 uses Turbopack by default. Its production build failed to resolve
these internal `.js`-to-TypeScript imports, so the web commands explicitly use
Webpack to apply the configured alias consistently:

- `dev`: `next dev --webpack --hostname 127.0.0.1`
- `dev:e2e`: `next dev --webpack --hostname 127.0.0.1 --port 3100`
- `build`: `next build --webpack`

`start` remains `next start --hostname 127.0.0.1` for serving a production
build.
