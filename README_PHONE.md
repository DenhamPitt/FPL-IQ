# FPL IQ — Phone Ready Edition (Team 144616)

This is an installable **web app** (PWA), not an App Store/iOS APK file. It has not yet been published to a live URL. It must run on an HTTPS-capable hosting service, because Python is used to fetch FPL's public data.

## Set it up from your phone using GitHub + Render

1. Unzip this file in the Files app (iOS) or Files/My Files (Android).
2. Open github.com in your mobile browser, sign up/log in, and create a repository (e.g. `fpl-iq`). Set it **private** if preferred. Open the repo, choose **Add file → Upload files** (on mobile you may need to request the desktop site), and upload ALL the extracted files in this folder, without putting them in a subdirectory. Commit the files. Note: some phone browsers make selecting multiple files difficult; if so, GitHub's web interface on desktop mode or Replit's ZIP import is an alternative.
3. Open https://dashboard.render.com, sign up/log in, choose **New → Blueprint**, link your GitHub account, select this repository, and approve the free Python web service in `render.yaml`. In some Render flows it may be simpler to choose **New → Web Service**, link the same repository, set build command `echo ready`, start command `python server.py`, and choose a Free instance.
4. After deployment, open the HTTPS `.onrender.com` URL from Render on your phone. It should attempt to fetch your public team automatically (FPL ID 144616). If the FPL API isn't reachable from Render, you'll see a connection error, not fake data. The `?demo=1` suffix loads fictional data instead.
5. **iPhone:** open the URL in Safari → Share → Add to Home Screen → Add. **Android:** open in Chrome → menu (⋮) → Install app or Add to Home screen.

If you only want to preview the design without hosting, use the separate `FPL_IQ_Interactive_Demo.html` file from the chat. This standalone demo never connects to your real team.

**Privacy / limitations**: no FPL password required; reads only published team data. Hosted app is reachable by people who have its URL. FPL data endpoints are unofficial and may block or change. Personal use only; verify predictions, transfers and chips in FPL. Free Render services may sleep after inactivity and take time to restart. No team/player data has been verified live in this workspace.

## v1.3 updates
- Navigation now stays pinned immediately under the logo, arranged as two rows of three buttons on phones. No horizontal ribbon scrolling.
- Refresh is aligned with the logo at top right; the connection status is a small dot on narrow screens.
- v1.2 prediction tracking and v1.1 transfer planning are retained.
- To update an already deployed website, replace the same-named files in your GitHub repository and commit them. Render should auto-deploy from `main`.
- Forecast history is stored **in this browser on this device**. Clearing website data or changing device can delete the forecasts; export important history when possible. Forecasts are not synced to the server.

## v1.4: overall FPL position
- The old **Money in bank** stat card is replaced with **Overall position** (e.g., **Top 18.0%**).
- The card uses the actual rank (`entry.summary_overall_rank`) divided by the up-to-date count (`bootstrap-static.total_players`), multiplied by 100. Rank 1 out of 11 million is shown as **Top <0.1%**, never as Top 0.0%.
- The second line shows the exact published rank and total teams, e.g. `Rank 1,985,149 of 11,028,606 managers`. The denominator updates on every FPL API refresh; the app does not assume that 11,028,606 will remain accurate.
- When the live API rank or manager count is missing/inconsistent, the card shows **—** instead of fabricating a percentile.
- The count includes registered managers, not just active ones; therefore it is the **overall FPL percentile**, not a ranking of active managers.
- Earlier v1.1 transfer review, v1.2 prediction tracker, v1.3 fixed header and top-right refresh are retained.
