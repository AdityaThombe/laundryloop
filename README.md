# LaundryLoop

Book a laundry pickup, follow it live through every step, and get it back in the slot you chose.
Four apps share one live database:

| App | URL | Who |
| --- | --- | --- |
| Customer app | `/customer` | People who need laundry done: book, track live, cancel, rate |
| Partner portal | `/provider` | Homemakers and local laundries: accept requests, receive and weigh clothes from the rider, wash/dry/iron, earnings |
| Delivery app | `/rider` | Delivery partners: go online, take pickup and drop jobs, confirm handovers with the customer's code, share location, earnings and cash |
| Admin console | `/admin` | Operations: live dashboard, verify providers and riders, assign orders and riders, issues, settlements, prices |

## Live site

https://laundryloop-ruby.vercel.app (Vercel, with a Neon Postgres database).

- Demo customer and provider accounts are one click away on the sign-in page.
- The admin account on the live site does **not** use the demo password. Its password is the `ADMIN_PASSWORD`
  environment variable on Vercel, and a copy is in `admin-login.local.txt` (git- and deploy-ignored).
- Redeploy after changes with `npx vercel deploy --prod`.

## Run it locally

Needs Node.js 24. Install once, then start:

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. Without `DATABASE_URL`, the app uses an embedded Postgres (PGlite) stored in `data/`,
so local testing never touches the live database. Set `DATABASE_URL` to point at any Postgres instead.
`npm run reset-db` deletes the local database so the next start re-seeds it.

### Seeded test accounts

| Role | Email | Password |
| --- | --- | --- |
| Customer | aditya@laundryloop.test | customer123 |
| Homemaker provider (verified) | sunita@laundryloop.test | provider123 |
| Laundry provider (verified) | ramesh@laundryloop.test | provider123 |
| Provider waiting for verification | meena@laundryloop.test | provider123 |
| Delivery partner (verified) | raju@laundryloop.test | rider123 |
| Delivery partner waiting for verification | imran@laundryloop.test | rider123 |
| Admin (local only) | admin@laundryloop.test | admin123 |

Sign-ins are stored per role, so you can keep the customer, partner and admin apps open in separate tabs of the same browser and watch an order move between them.

## The workflow

1. **Customer books**: service, estimated weight, pickup and delivery slots, address, optional preferred laundry and notes. Sees the estimate plus a ₹40 pickup & delivery fee (free above ₹400).
2. **A laundry accepts**: verified providers who are accepting orders get the request (or only the one the customer picked). First to accept wins; only then do they see the address and phone.
3. **Pickup leg**: the job goes to online, verified delivery partners. One takes it, goes to the customer, counts the items and enters the customer's 4-digit **pickup code** from their app.
4. **Handover at the laundry**: the homemaker counts and weighs the bag. That sets the final price, and an item-count mismatch opens an issue for support automatically.
5. **Processing**: Washing → Drying → Ironing → Ready (steps depend on the service).
6. **Drop leg**: a delivery partner takes the delivery job, collects from the laundry, and at the door enters the customer's **delivery code** and records cash or UPI.
7. **Rating and problems**: the customer rates the laundry and can report missing or damaged items; support resolves them, with an optional refund.

Real-world cases it handles:

- **Nobody home**: the rider logs a failed attempt. The pickup or delivery is paused, the laundry keeps the bag, and the customer picks a new slot.
- **Rider can't make it**: they can drop a job before collecting it, and it reopens for others. Support can assign or reassign any leg.
- **No rider free**: a homemaker can do the pickup or delivery herself and earn the leg fee.
- **Customer changes plans**: they can change the pickup slot before pickup, and the delivery slot until it's out for delivery.
- **Money**: riders earn ₹25 per leg; laundries earn 85% of the laundry price. Cash collected at the door is tracked per partner, and the admin Settlements page nets it against their earnings.
- **Rider location** is shared with the customer only while the rider is on their way to them.

Every step is logged with time and who did it and sends an in-app notification. Open screens check `/api/pulse` every few seconds and refresh when something changed.

## Project layout

```
app.js             REST API, auth, workflow rules (shared by local and Vercel)
server.js          Local server: static files + API
api/index.js       Vercel function wrapping app.js
db.js              Postgres schema, password hashing, seed data
vercel.json        Vercel routing
public/index.html  Sign in / create account (customer or provider)
public/customer.html
public/provider.html
public/rider.html
public/admin.html
public/present.html Hidden slide presenter (see below)
public/common.js   Shared API client, live updates, formatting, timeline
public/styles.css  Shared styles: paper-and-ink palette, Bricolage Grotesque / Instrument Sans / IBM Plex Mono, light and dark themes
```

## Hidden slide presenter

`/present` lets you upload a deck and present it full screen in the browser, so you don't need to open PowerPoint.
Nothing in the app links to it. To get there, type `present` on any page (outside a text box), tap the LaundryLoop
logo five times quickly, or open `/present` directly.

- Separate **Upload PowerPoint** and **Upload PDF** buttons (or drop a file). A PDF is presented page by page, one
  page per slide.
- Accepts **.pptx**, **.pdf** and images (several images become one deck, ordered by file name). Old `.ppt` files
  must be saved as .pptx or PDF first.
- PPTX slides are drawn in the browser ([pptx-preview](https://www.npmjs.com/package/pptx-preview)), so animations,
  video and some fonts can differ. Exporting to PDF from PowerPoint gives an exact copy ([PDF.js](https://mozilla.github.io/pdf.js/)).
- Decks are saved in the browser (IndexedDB) on that device only; nothing is uploaded to the server.
- Keys: `→`/`Space` next, `←` previous, `F` full screen, `G` all slides, `B` black screen, a number then `Enter`
  jumps to that slide, `Esc` exits. Swipe works on touch screens, and clicking the left or right half of the slide steps back or forward.

## What it does not do yet

- Payment is cash on delivery only; there is no card/UPI gateway.
- Notifications are in-app only (no SMS or push).
- Rider location is the phone's last reported position (every ~20 s), not turn-by-turn tracking.
- Updates arrive by polling every 3 seconds rather than instant push.
