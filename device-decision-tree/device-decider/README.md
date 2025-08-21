
# Quick Start (Next.js + Tailwind + shadcn/ui)

## 0) Prereqs

* Node 18+ (`node -v`)
* npm (or yarn/pnpm)

## 1) Create a new app with Tailwind

```bash
npx create-next-app@latest device-decider --typescript --tailwind --eslint
cd device-decider
```

## 2) Add libraries used by the component

```bash
npm i framer-motion lucide-react
```

## 3) Initialize shadcn/ui and add components

```bash
npx shadcn@latest init -d
npx shadcn@latest add button card badge
npx shadcn@latest add input label
```

* If it asks about an alias, pick `@/` (default).

## 4) Ensure the `@/` alias works (usually already set)

Open `tsconfig.json` and make sure you have:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  }
}
```

## 5) Add the interactive page

* In your project, create a file: `app/DeviceDecisionExplorer.tsx`

* Copy the **entire** component from the canvas (“Device Decision Explorer — Interactive Draft”) into that file.

* Then open `app/page.tsx` and replace its contents with:

```tsx
import DeviceDecisionExplorer from "./DeviceDecisionExplorer";

export default function Page() {
  return <DeviceDecisionExplorer />;
}
```

## 6) Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you should see **Paths to Your Next Device** with the Q\&A on the left and the **tree visualization** on the right.

---

## Optional polish

* **Dark mode**: Tailwind + shadcn are dark-ready. If you want a toggle, I can add it.
* **Fonts & branding**: Add your State Overflow font/colors in `globals.css` and Tailwind theme.
* **Static export for Substack**: We can host this mini app on Vercel and embed, or export path screenshots.

## Common gotchas

* **“Module not found '@/components/ui/…'”**
  You didn’t run `npx shadcn add button card badge` or the alias isn’t set. Re-run step 3 and confirm step 4.

* **Tailwind not applying styles**
  Ensure `globals.css` is imported in `app/layout.tsx` and Tailwind `content` includes `./app/**/*.{ts,tsx}`.

* **TypeScript errors about React/JSX**
  Make sure `\"jsx\": \"preserve\"` (or `\"react-jsx\"`) is set in `tsconfig.json` (create-next-app handles this by default).

---

Want me to:

* generate a **minimal, no-shadcn** variant (plain HTML buttons) for a super quick drop-in,
* or a **Vite** version (React + Tailwind + shadcn),
* or add a **price/spec panel** that pulls in a local JSON?

