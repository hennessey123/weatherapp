# Weather App — Architecture & Ground Rules

## Stack
- **Next.js** (App Router) — React 19
- **shadcn/ui** — all UI components, no custom primitives
- **TanStack Query v5** — all client-side server state
- **Tailwind CSS v4** — styling
- **TypeScript** — strict mode

---

## 1. Server Functions for All Backend Logic

Every backend operation uses `'use server'` — no API routes, no route handlers.

```ts
// app/actions/weather.ts
'use server'

export async function getWeather(city: string) {
  const res = await fetch(`https://api.weather.com/...`)
  return res.json()
}
```

**Two ways server functions get called:**
- **Forms** — `<form action={serverFn}>`, receives `FormData`
- **Direct calls** — via TanStack Query `queryFn` / `mutationFn` from client components

Server functions are the only door to the backend. Never bypass them.

---

## 2. TanStack Query for All Client State

All server data flows through TanStack Query. Set `staleTime` thoughtfully — don't leave it at `0` (refetches constantly) or `Infinity` (never updates).

```tsx
// Reading data
const { data, isLoading } = useQuery({
  queryKey: ['weather', city],
  queryFn: () => getWeather(city),
  staleTime: 5 * 60 * 1000, // 5 min — weather doesn't change by the second
})

// Writing / triggering mutations
const save = useMutation({
  mutationFn: saveLocation,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['locations'] }),
})
```

Query keys are the cache address. Design them like URL paths — specific enough to avoid collisions, general enough for targeted invalidation.

```ts
['weather', city]           // all weather for a city
['weather', city, 'hourly'] // just hourly forecast
```

---

## 3. NO useEffect — This Is the Core Rule

`useEffect` is a last resort, not a tool. Almost every use case has a better replacement.

### The Replacement Table

| You want to... | Don't do this | Do this instead |
|---|---|---|
| Fetch data on mount | `useEffect(() => fetch(...))` | `useQuery` |
| Refetch when a value changes | `useEffect([dep])` → fetch | `useQuery` with key that includes the dep |
| Run a mutation on user action | `useEffect` watching a flag | `useMutation` called in event handler |
| Derive a value from state/props | `useEffect` → `setState` | Compute inline or `useMemo` |
| Sync two pieces of state | `useEffect([a], () => setB(...))` | Remove the redundant state — derive B from A |
| Reset state when a prop changes | `useEffect([prop], () => reset())` | Put a `key={prop}` on the component |
| Subscribe to external store | `useEffect` + manual subscribe | `useSyncExternalStore` |
| DOM measurement / refs | Often `useEffect` | `useLayoutEffect` (sync) or a ref callback |
| One-time setup on mount | `useEffect([], ...)` | Move to Server Component, or use `useQuery` with `enabled` |

### Why This Architecture Makes useEffect Rare

In a typical React app, `useEffect` is used heavily because there's no clean way to fetch data or respond to async events. TanStack Query + Server Functions eliminate those use cases:

- **Data fetching** → `useQuery` handles loading, caching, deduplication, background refetch
- **Mutations** → `useMutation` handles optimistic updates, error states, invalidation
- **Server interaction** → Server functions are called directly, no client-side fetch boilerplate

The only valid `useEffect` uses are synchronizing with **non-React external systems**:
- Third-party widgets that imperatively manipulate the DOM
- `IntersectionObserver`, `ResizeObserver`, `MutationObserver`
- WebSocket connections (though prefer `useSyncExternalStore`)
- Non-React animation libraries

**If you write a `useEffect`, add a comment explaining why no alternative works.**

### Derive, Don't Sync

The biggest source of `useEffect` abuse is syncing derived state. Never store something that can be computed.

```tsx
// BAD — useEffect syncing derived state
const [filtered, setFiltered] = useState(items)
useEffect(() => {
  setFiltered(items.filter(i => i.active))
}, [items])

// GOOD — derive during render (free if cheap)
const filtered = items.filter(i => i.active)

// GOOD — memoize if genuinely expensive
const filtered = useMemo(() => items.filter(i => i.active), [items])
```

---

## 4. Rendering Architecture

**Server Components are the default.** Only add `'use client'` when you need interactivity.

| Concern | Where it lives |
|---|---|
| Data fetching for initial render | Server Component — just `await` it |
| Static layout, SEO content | Server Component |
| Forms, clicks, hover, animations | Client Component |
| TanStack Query hooks | Client Component |
| `useState`, `useRef` | Client Component |

Keep client boundaries as **small and as deep** in the tree as possible. A page can be a Server Component that passes data down to a small interactive island.

```tsx
// app/page.tsx — Server Component
export default async function Page() {
  const initialData = await getWeather('NYC') // runs on server
  return <WeatherCard initialData={initialData} />
}

// components/weather-card.tsx — Client Component
'use client'
export function WeatherCard({ initialData }) {
  const { data } = useQuery({
    queryKey: ['weather', 'NYC'],
    queryFn: () => getWeather('NYC'),
    initialData, // hydrate from server, then keep fresh
  })
  ...
}
```

---

## 5. State Ownership

Each piece of state has one home. Never duplicate.

| State type | Where it lives |
|---|---|
| Server data | TanStack Query cache |
| URL / navigation state | `searchParams` / `useRouter` |
| Local UI state (modals, tabs, toggles) | `useState` in the nearest component |
| Form input state | Uncontrolled via `FormData` or controlled `useState` |

If you find yourself copying TanStack Query data into `useState`, stop — you're creating a second source of truth that will drift.

---

## 6. shadcn/ui

Use it for everything. Don't build custom primitives when a shadcn component exists.

```bash
npx shadcn@latest add button card input skeleton
```

Customize via `className` and `cn()` utility — don't fork the component source unless absolutely necessary.
