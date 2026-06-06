# WebCareLeader — Elementor Implementation Guide

> **File:** `landing-page.html` is the source of truth for all copy and layout.  
> This guide explains how to build each section inside Elementor page builder.

---

## ⚙️ Global Elementor Settings

### Site Identity
| Setting | Value |
|---|---|
| Site name | WebCareLeader |
| Primary font | Inter (Google Fonts) |
| Secondary font | Inter (same family, heavier weights) |

### Design System
| Token | Value |
|---|---|
| Primary colour | `#1B4FFF` (trust blue) |
| Accent colour | `#00C48C` (growth green) |
| Dark background | `#0D1B2A` (deep navy) |
| Light background | `#F5F7FA` (off-white) |
| Border colour | `#E2E8F0` |
| Body text | `#1A202C` |
| Muted text | `#5A6478` |
| Card border-radius | `12px` |
| Button border-radius | `6px` |

### Elementor Global Settings (Site Settings → Style)
- Enable **Flexbox Containers** under Experiments
- Set **Content Width** to `1160px`
- Set **Column Gap** to `20px`
- Import Inter font via Elementor → Custom Fonts or Google Fonts manager

---

## 📐 Section-by-Section Elementor Build Guide

---

### NAVIGATION
**Widget:** Theme Builder Header or Nav Menu widget  
**Layout:** Sticky, white background `rgba(255,255,255,0.95)`, `backdrop-filter: blur(8px)`, border-bottom `1px solid #E2E8F0`, height `68px`  
- **Left:** Text widget — `WebCare<span style="color:#1B4FFF">Leader</span>`
- **Right:** Button widget — "Get Free Website Checkup" — Primary style, padding `10px 22px`

---

### SECTION 1 — HERO

**Section Settings:**
- Background: Solid colour `#0D1B2A`
- Min height: `680px`
- Padding: `96px 0 80px`
- Overflow: Hidden

**Shape Dividers:**
- Bottom: Wave, white fill, height `60px`

**Layout:** 2-column container, `60% / 40%` split, gap `48px`, align items: center

**Left Column (Copy):**
1. **Text widget** — Eyebrow: `"✦ Professional Website Maintenance"` — colour `#00C48C`, font 13px, weight 600, uppercase
2. **Heading widget (H1):** `Your Website Deserves More Than "Set It and Forget It."` — white, size clamp `2.2–3.4rem`, weight 800. Wrap "Set It and Forget It." in a `<span>` styled `color:#00C48C`
3. **Text widget** — subheadline paragraph — colour `#94A3B8`, size `1.15rem`
4. **Button Group (2 buttons):**
   - Button 1: "✓ Get My Free Website Checkup" — accent green `#00C48C`, padding `15px 36px`
   - Button 2: "View Care Plans →" — transparent, white border `2px`
5. **Icon List widget** (horizontal, gap 28px) — trust bar items:
   - 🛡️ No long-term contracts
   - ⚡ Results in 48 hours  
   - 💬 Real humans, real support
   - Colour: `#94A3B8`, icon colour: `#00C48C`
   - Add top border `1px solid rgba(255,255,255,0.10)`, padding-top `28px`

**Right Column (Visual):**
> Replace the HTML mock with a professional **browser mockup image** showing a website performance dashboard.
> - Recommended: Figma-designed device mockup, 540×400px PNG
> - Alternatively: A real screenshot of a Google PageSpeed or Wordfence dashboard
> - Add CSS: `border-radius: 18px; border: 1px solid rgba(255,255,255,0.10);`

---

### SECTION 2 — PROBLEM

**Section Settings:**
- Background: White `#ffffff`
- Padding: `88px 0`

**Layout:** 1-column container

**Widgets:**
1. **Badge** (Text widget with CSS class `.badge`): "The Real Cost of Neglect"
2. **Heading (H2):** "Is Your Website Quietly Driving Customers Away?"
3. **Text widget** — intro paragraph, max-width `660px`, centred
4. **4-column Icon Box grid:**

| Card | Icon (Font Awesome) | Colour |
|---|---|---|
| Security Vulnerabilities | `fa-shield-exclamation` | `#EF4444` |
| Slow Page Speed | `fa-gauge` | `#F97316` |
| Broken Links & Errors | `fa-link-slash` | `#EF4444` |
| Outdated Content & Software | `fa-arrow-trend-down` | `#F97316` |

- Card style: white bg, `1px solid #E2E8F0`, `border-radius 12px`, hover: box-shadow + translate-Y `-4px`

5. **Alert box** (Inner Section widget, full width):
   - Background `#FFF5F5`, border `1px solid #FED7D7`, radius `12px`, padding `32px`
   - Text: centred, red `#C53030`, weight 600

---

### SECTION 3 — SERVICES INCLUDED

**Section Settings:**
- Background: `#F5F7FA`
- Padding: `88px 0`

**Layout:** 1-column intro → 3-column icon list grid

**Icon Box Grid (9 items, 3 columns):**

Each item uses a **Flex container** (horizontal):
- **Left:** Icon widget inside a `50×50px` container, background `rgba(27,79,255,0.08)`, border-radius `12px`
- **Right:** H3 (16px, weight 700) + paragraph (14px, muted)

| Service | Icon | 
|---|---|
| Security Monitoring | `fa-shield-check` |
| Plugin & Theme Updates | `fa-arrows-rotate` |
| Daily Off-Site Backups | `fa-cloud-arrow-up` |
| Speed Optimisation | `fa-bolt` |
| Uptime Monitoring | `fa-chart-line` |
| SSL Certificate Management | `fa-lock` |
| Broken Link Scanning | `fa-magnifying-glass` |
| Content Updates | `fa-pencil` |
| Monthly Report & Support | `fa-headset` |

---

### SECTION 4 — PRICING

**Section Settings:**
- Background: `#0D1B2A`
- Padding: `88px 0`

**Layout:** 1-column intro → 3-column pricing card grid

**Pricing Card Specs:**

| Plan | Price | Border | Transform |
|---|---|---|---|
| Essentials | $79/mo | `1px solid rgba(255,255,255,0.10)` | none |
| Professional | $149/mo | `2px solid #1B4FFF` | `scale(1.04)` |
| Business | $249/mo | `1px solid rgba(255,255,255,0.10)` | none |

**Professional card (Popular):**
- Background: White `#ffffff` (all text → dark)
- Add **absolute-positioned badge** above card: "⭐ Most Popular" — blue bg, white text, `border-radius: 100px`
- CTA button: primary blue

**Feature List widget:**
- Use Elementor **Icon List** widget
- Included items: checkmark ✓ in `#00C48C`
- Excluded items: dash `—` in `#94A3B8`, opacity `0.45`

**Footer note:** Centred text widget, colour `#64748B`, with inline link to checkup form

---

### SECTION 5 — WHY WEBCAREPLEADER

**Section Settings:**
- Background: White `#ffffff`
- Padding: `88px 0`

**Layout:** 2-column, `50% / 50%`, gap `72px`, align-items: center

**Left Column:**
1. Badge widget
2. H2: "We're Not an Agency. We're Your Website's Caretaker."
3. Intro paragraph
4. **4 differentiator rows** — each a flex container:
   - Icon in `46×46px` container (`rgba(27,79,255,0.08)` bg, radius `10px`)
   - H3 + paragraph text block

| Differentiator | Icon |
|---|---|
| Real Humans, Not Bots | `fa-user-check` |
| Fast Turnaround, Always | `fa-clock` |
| Full Transparency | `fa-file-chart-column` |
| We Speak Plain English | `fa-heart` |

**Right Column (2×2 stat grid + testimonial):**
1. **2×2 grid** of stat cards:
   - Background `#F5F7FA`, radius `12px`, padding `28px 24px`
   - Large number: `2.4rem`, weight 800, colour `#1B4FFF`
   - Label: `0.88rem`, muted

| Stat | Label |
|---|---|
| 98% | Client satisfaction rate |
| <24h | Average response time |
| 500+ | Websites maintained |
| 0 | Data breaches on our watch |

2. **Testimonial card** (full width):
   - Background `#1B4FFF`, radius `12px`, padding `28px 24px`
   - Blockquote italic text, white `rgba(255,255,255,0.90)`
   - Cite: `0.85rem`, white `rgba(255,255,255,0.65)`

---

### SECTION 6 — FAQ

**Section Settings:**
- Background: `#F5F7FA`
- Padding: `88px 0`

**Layout:** 1-column, max-width `760px`, centred

**Widget:** Elementor **Accordion** widget (built-in)
- Style: white background, `1px solid #E2E8F0`, radius `10px`
- Active title colour: `#1B4FFF`
- Icon: `+` / `−` (right-aligned)
- No box shadows needed

**8 FAQ items** — see `landing-page.html` for all copy

---

### SECTION 7 — FINAL CTA

**Section Settings:**
- Background: Gradient `linear-gradient(135deg, #1340CC 0%, #1B4FFF 60%, #0EA5E9 100%)`
- Padding: `100px 24px`
- Overflow: Hidden

**Shape Dividers:**
- Top: Wave, white fill, height `80px` (to match previous section bg)

**Layout:** 1-column container, max-width `700px`, centred, all text centred

**Widgets:**
1. Badge: "🎁 Free, No Obligation" — `rgba(255,255,255,0.15)` bg, `#E0F2FE` text
2. **H2 (white):** "Find Out Exactly What's Wrong With Your Website — For Free"
3. **Paragraph:** benefit summary — `rgba(255,255,255,0.80)`, size `1.1rem`
4. **Button group (centred, row, gap 16px):**
   - Button 1: "✓ Yes — Check My Website for Free" — **white bg, primary-blue text**, box-shadow
   - Button 2: "View Plans First" — transparent, white border
5. **Trust line:** "No credit card required · No sales pressure · Results in 48 hours" — small text, low-opacity white

**Decorative elements:**
- Add 2 large circle shapes (ornaments) via Elementor background shapes or custom CSS pseudo-elements
- Sizes: `500px` and `300px`, `rgba(255,255,255,0.06)`, positioned top-right and bottom-left

---

## 🎯 Conversion Optimisation Tips

1. **Hero CTA button** should link to an embedded form (Elementor Form widget or Gravity Forms) — anchor `#checkup`
2. **Sticky nav CTA** — keep "Get Free Website Checkup" visible at all times
3. **Pricing CTA buttons** — all link to the same free checkup form (lower friction than immediate payment)
4. **FAQ items** — keep answers concise; don't bury the CTA. Add an inline CTA link inside the last FAQ answer
5. **Mobile:** On mobile, hero is single column; pricing cards stack; hide the hero visual panel
6. **A/B test headline:** Try "Is Your Website Losing You Customers?" vs current H1

---

## 📦 Recommended Elementor Plugins

| Plugin | Purpose |
|---|---|
| Elementor Pro | Popup forms, Theme Builder, sticky header |
| MetForm or Gravity Forms | Free checkup request form |
| WPForms Lite | Alternative simple form |
| LottieFiles (Elementor add-on) | Animated icons for service section |
| Elementor Extras | Advanced hover effects |

---

## 🖼️ Image/Asset Recommendations

| Section | Asset |
|---|---|
| Hero right column | Browser mockup with performance dashboard (Figma or Canva) |
| Why WebCareLeader | Headshot of team member or office photo |
| Testimonial | Client photo (circular, 60×60px) |
| Favicon | Shield or "W" monogram, `#1B4FFF` |
| OG image | 1200×630px branded banner |

---

*Built for WebCareLeader · `/webcareLeader/landing-page.html`*
