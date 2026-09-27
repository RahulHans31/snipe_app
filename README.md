# Snipe Desktop

This is a separate Electron desktop control surface for the Snipe workflow. It keeps its own local profile and opens Flipkart in Electron windows, so the browser session used by the app is independent from Chrome.

## Run

```powershell
npm install
npm start
```

Use **Open session** once to sign in to Flipkart, add product URLs containing `pid`, configure the runtime, and engage. Targets are tracked through the Flipkart API in the Electron main process; product pages are not opened. When checkout returns a Flipkart payment URL, Snipe opens only that payment page in a separate window for the target/account. Stopping the lanes closes payment windows.

## Important architecture note

The checkout engine is now migrated into `engine/checkout.js`. Electron supplies a compatibility bridge for the engine's cookie and runtime calls, and the dispatcher runs independent target/account jobs concurrently with a bounded worker pool. Payment modes that require user interaction still open Flipkart's own payment UI; the app does not store CVV or silently bypass OTP/3DS.

The lane dispatcher is isolated in `main.js`, so the current checkout engine can be ported behind that boundary later without changing the desktop UI. The existing extension remains untouched.
