# Strata Compact Design System

## Core Principles
- **100vh Layout**: App shell uses flexbox with fixed header and scrolling content
- **No Full-Page Scroll**: Only inner content areas scroll
- **Data Density**: Maximize information per pixel
- **Fast Scanning**: Decision-critical info first, no hero sections

## Header System (Fixed at 64px)
```
- Logo: 32px max
- Title: 0.8rem, no tagline
- Nav: Gap 0.25rem, tight spacing
- Fixed to top, sticky on scroll
```

## Page Layout Pattern

All pages should wrap content in `.shell` class:
```jsx
<div className="shell">
  <h1>Page Title</h1>
  <p className="subtitle">Optional subtitle</p>
  
  <div className="panel">
    {/* Content here */}
  </div>
</div>
```

## Spacing Rules (Global)

### Vertical Gaps
- Between major sections: `gap-4` or `gap-0.8rem`
- Between form fields: `gap-3` or `gap-0.6rem`
- Between items in lists: `gap-2` or `gap-0.4rem`

### Padding
- Panels/cards: `p-3` or `p-0.9rem` (was p-6)
- Shell wrapper: `padding: 1.2rem 1.2rem 1.5rem` (was 2.4rem 0 3rem)
- Page margins: Built into shell, no extra margins

### Margins
- Page title: `margin: 0.2rem 0` (was 0.45rem)
- Subtitles: `margin: 0.3rem 0 0` (was 0)

## Typography System

### Sizes
- H1: `clamp(1.4rem, 3vw, 2rem)` (was clamp(2.1rem, 5.2vw, 4.2rem))
- H2/H3: `font-size: 0.95rem` (was 1.02rem)
- H4/Labels: `font-size: 0.8rem` (was 0.85rem)
- Body: `font-size: 0.85rem` (default)
- Small: `font-size: 0.7rem-0.75rem`

### Line Height
- Headings: `line-height: 1.2`
- Body: `line-height: 1.4-1.5` (was default)

## Card System

All cards follow this pattern:
```css
.panel {
  border: 1px solid var(--line);
  background: linear-gradient(160deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
  border-radius: 12px;
  padding: 0.9rem;
  backdrop-filter: blur(6px);
}
```

## Common Layouts

### Table/List Grid
```css
display: grid;
grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
gap: 0.4rem;
```

### Side-by-Side (Simulate Page)
```css
display: grid;
grid-template-columns: 2fr 1fr;
gap: 0.6rem;
```

### Stat Cards
```css
display: grid;
grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
gap: 0.6rem;
```

## Button Styling

```css
button {
  border: 1px solid rgba(236, 243, 255, 0.1);
  border-radius: 8px;
  padding: 0.4rem 0.7rem;
  font-weight: 600;
  font-size: 0.8rem;
  color: #d7e4f3;
  background: rgba(11, 18, 32, 0.8);
  cursor: pointer;
  transition: all 120ms ease;
}

button:hover {
  border-color: rgba(62, 198, 255, 0.3);
  background: rgba(47, 123, 255, 0.12);
}
```

## Do's and Don'ts

### ✅ DO
- Use `.shell` wrapper on all pages
- Use `.panel` for cards
- Keep gaps at 0.4rem-0.8rem
- Reduce padding to 0.3rem-0.9rem
- Keep headers tight to content
- Use grid for lists/tables
- Only inner containers scroll

### ❌ DON'T
- Add large top/bottom margins
- Use py-8, px-8, p-6, gap-8
- Create hero sections
- Wrap content in extra divs with padding
- Full-page scroll
- Use inline Tailwind sizes without checking globals.css first
- Add taglines or subtitles at top

## Converting Old Pages

1. Find the `.shell` class wrapper
2. Replace padding: `2.4rem 0 3rem` → `1.2rem 1.2rem 1.5rem`
3. Replace gaps: `gap-8` → `gap-4`, `gap-6` → `gap-3`
4. Remove hero sections (large titles + empty space)
5. Remove large subtitles (set display: none if needed)
6. Update card padding: `p-6` → `p-3`, `p-8` → `p-4`
7. Update grid min-width: `minmax(200px, 1fr)` → `minmax(140px, 1fr)`
8. Test: User should see data without scrolling on laptop view

## Examples

### Opportunities Page
- Compact table rows with symbol, bias, confidence, entry
- No large card per opportunity
- Click to open side panel, not full page

### Forecast Page
- Same table pattern as opportunities
- Horizontal scroll for data density
- No hero section

### Simulate Page
- Left: Inputs (2fr width)
- Right: Results (1fr width)
- No top padding wasted
- Inputs visible + results visible simultaneously

### Agent Page
- Chat visible first
- Input bar at bottom (sticky)
- No extra header/padding

## Testing Your Changes

At 100% zoom on 1400px width laptop:
1. Header should be barely visible (64px)
2. Page title and first data row visible without scroll
3. Data table/content fills remaining space
4. No large empty areas
5. All action buttons small and grouped
6. Mobile: Header collapses nav, content stays tight
