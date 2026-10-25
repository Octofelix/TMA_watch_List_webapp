# Seaplane Watch

Track Trans Maldivian Airways (TMA) seaplane arrivals to any resort or island, such as LUX* South Ari Atoll, and get phone notifications as the flight's status changes. It installs on phones like an app.

## How it works

1. **Create an account** with your name, a username and a password, then switch on notifications for your phone (see *Phone notifications* below).
2. **Watch a flight.** Pick the destination (67 TMA resorts are built in, grouped by atoll), the date, and optionally the expected time and a label (guest name, booking ref). You can add any local island or resort that isn't listed by searching for it or clicking the map.
3. **Enter the tail code** (e.g. `8Q-TMB`, `8QTMB` or just `TMB`) once TMA confirms which aircraft is flying. The app checks it against the aircraft registry, and only a real TMA aircraft can be confirmed. You get a notification straight away: *aircraft assigned*.
4. **Status updates.** The app checks free live flight-tracking feeds (adsb.fi, adsb.lol) every 30 seconds for that aircraft and sends a notification when the plane:
   - **departs** (with distance and estimated minutes),
   - is **approaching** (within 15 km),
   - has **landed** (on the water within 5 km of the destination).

   You can also set *Departed / Approaching / Landed / Delayed / Cancelled* by hand on each flight. This matters because seaplanes fly low, and the free tracking feeds don't always pick them up around the atolls.

Each flight has its own checkboxes, so you choose which updates you're notified about. Updates for the same flight replace each other on the phone instead of piling up.

## Phone notifications

Notifications go straight to phones with **Web Push**. There's no SMS or WhatsApp, and nothing to pay for.

**Each user switches them on once per device:**
- **Android (Chrome, Edge, Samsung Internet):** open the site, tap **Install app** (or the browser menu → *Install app* / *Add to Home screen*), then **Turn on notifications** and allow.
- **iPhone / iPad (iOS 16.4 or newer):** open the site in **Safari** → **Share** → **Add to Home Screen** → open **Seaplane** from the Home Screen → **Turn on notifications** and allow. Apple only allows notifications for apps added to the Home Screen.
- **Computer (Chrome, Edge, Firefox):** open the site and turn notifications on. No install needed.

The **Profile** tab shows which devices get notifications, with a **Send a test notification** button. Admins can send a test to any user from **Admin → Manage**. Logging out turns notifications off on that device.

**Needs HTTPS.** Hostinger provides it. It also works on `http://localhost` for testing on the computer running the app.

**Keys.** `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` identify the app to Apple's and Google's push services. Make a pair once with `npx web-push generate-vapid-keys`, put them in `.env` and in your host's environment variables, and **never change them**: new keys mean every device has to switch notifications on again. If they're missing, the app makes a pair and saves it in `data/vapid.json`. Set `VAPID_SUBJECT` to `mailto:` followed by your own email address.

**App icons** are made from the logo. After changing the logo in `public/brand/`, run `node scripts/make-icons.js`.

## Tabs

- **Flights**: flights being watched now, and the form to add one. Tick **Share with all users** to make a flight visible to everyone. Every update for a shared flight (manual or from live tracking) then goes to all users with notifications on, marked "📢 Shared by …". Users can turn these off on their Profile page.
- **History**: flights move here automatically once they **land** or are **cancelled**, or when you press **Stop watching**. Filter by All / Mine / Shared. A flight you stopped can be moved back with **Watch again**.
- **Chat**: one group chat for all users. New messages appear every few seconds, and a red dot on the tab means there are unread ones. You can delete your own messages; the admin can delete any.
- **Profile**: change your photo, name, username and password, and manage notifications for your devices. Changing your password logs out your other devices.
- **Admin** (admin only): numbers at a glance, every user account (edit details, set a new password, change their photo, make admin, disable, delete, send a test notification), and every notification the app has sent. The admin also sees and can manage all users' flights on the Flights and History tabs.

## Admin account

On first start the app creates an admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`. After that, change the admin password on the Profile page. Editing `.env` won't change it.

## Theme

The colours come from the TMA logo in `public/brand/` (TMA red, charcoal and silver). The logo also appears in the header, as the browser-tab icon and as the phone app icon. The colour values are at the top of `public/styles.css`. Light and dark mode both follow the device setting.

## Run it

Needs Node.js 22.13 or newer (it uses Node's built-in SQLite).

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000.

## Files

| Path | What it is |
|---|---|
| `src/server.js` | Starts the web server |
| `src/routes/account.js` | Sign-up, login, profile, notification on/off |
| `src/routes/watches.js` | Destinations, flights, sharing, stop/history |
| `src/routes/chat.js` | Group chat |
| `src/routes/admin.js` | Admin user management |
| `src/tracker.js` | Live tracking, status rules, who gets notified, notification wording |
| `src/push.js` | Sends phone notifications (Web Push) and stores each device |
| `src/aircraft.js` | Checks tail codes against the aircraft registry; live positions |
| `src/auth.js` | Passwords, login sessions, admin account set-up |
| `src/db.js` | SQLite database (`data/seaplane-watch.db`); profile pictures go in `data/avatars/` |
| `public/sw.js` | Service worker: shows notifications, opens the app when tapped, works offline |
| `public/manifest.webmanifest`, `public/icons/` | Makes the site installable as a phone app |
| `public/` | The web page (`js/` has one file per tab; `brand/` holds the logo) |
| `data/destinations.json` | Built-in TMA destinations with coordinates |
| `scripts/geocode.js` | Rebuilds destination coordinates from OpenStreetMap |
| `scripts/make-icons.js` | Builds the app icons from the logo |

## Limits to know

- **Live tracking isn't guaranteed.** There's no public TMA flight-status API. The app relies on community ADS-B receivers, and coverage over the outer atolls is patchy. If a plane drops off tracking on final approach, the app marks it landed after 3 minutes of silence and says so in the notification. Manual updates always work.
- **Destination list.** The 67 resorts are TMA seaplane destinations I'm aware of. TMA's network changes, so add any that are missing through "Not listed?". Coordinates come from OpenStreetMap and should be accurate to about 1 km.
- **Tracking runs only on the flight date** (Maldives time), and only after a tail code is entered.
- **Notifications need the user's OK on each device.** Anyone who hasn't switched them on (or uses an iPhone without adding the app to the Home Screen) won't get notifications, but can still see everything in the app.
