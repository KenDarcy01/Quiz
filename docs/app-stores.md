# Publishing to the App Store and Google Play

Family Quiz ships to both stores as a [Capacitor](https://capacitorjs.com) app: the website, copied into a native shell, plus a few phone features (haptics when the quiz master marks an answer, the native share sheet for watch links, the screen kept awake during a game, Android back button). Both apps are built in the cloud by GitHub Actions, so no Mac is needed. The website itself still has no build step; GitHub Pages serves the repo root as before.

- App id (iOS bundle id and Android package): `app.familyquiz.quiz`. It cannot change after the first upload.
- Publisher: Ken's personal (individual) Apple Developer and Google Play accounts.
- Version: `version` in `package.json`. Build numbers come from the workflow run number.
- Price: paid. On Google Play, set the app as paid before the first release, because a free app can never become paid.
- Privacy policy: https://familyquiz.app/privacy.html
- Support page: https://familyquiz.app/support.html

## Day to day

```bash
npm install
npm run native:sync     # copy the website into www/, then into ios/ and android/
npm run native:assets   # redraw every icon and splash screen from icons/icon.svg (needs Playwright)
```

Pull requests that touch the app run `iOS app` and `Android app` checks that make sure both still compile.

To release, open the repo's **Actions** tab, pick **iOS app** or **Android app**, and press **Run workflow** on `main`.

## One-time setup: iOS

1. **Register the app id.** In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), add an App ID with bundle id `app.familyquiz.quiz`. No extra capabilities are needed.
2. **Create the app** in [App Store Connect](https://appstoreconnect.apple.com/apps) → **+** → New App: platform iOS, name (see below), bundle id from step 1, SKU `familyquiz`.
3. **Create an API key.** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**. Give it the **Admin** role, which lets the build create its own signing certificate. Download the `.p8` file (it can only be downloaded once) and note the Key ID and the Issuer ID shown above the list.
4. **Find your Team ID** under Membership details at [developer.apple.com/account](https://developer.apple.com/account).
5. **Add four repository secrets** at GitHub → repo Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `ASC_KEY_ID` | The Key ID from step 3 |
| `ASC_ISSUER_ID` | The Issuer ID from step 3 |
| `ASC_PRIVATE_KEY` | The whole text of the `.p8` file, including the BEGIN and END lines |
| `APPLE_TEAM_ID` | The Team ID from step 4 |

Then run **iOS app** from the Actions tab. The build appears in App Store Connect → TestFlight after Apple processes it (10 to 30 minutes). Add yourself as an internal tester and install it with the TestFlight app.

## One-time setup: Android

1. **Make an upload key.** Any Java install can do it:
   ```bash
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   Keep the file and its password safe. Google Play App Signing holds the real signing key, so a lost upload key can be reset through Play Console support, but it takes a few days.
2. **Add four repository secrets:**

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The keystore file in base64 (`base64 -w0 upload.jks` on Linux, `base64 -i upload.jks` on macOS, `[Convert]::ToBase64String([IO.File]::ReadAllBytes("upload.jks"))` in PowerShell) |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | The key password (the same as the keystore password unless you set a different one) |

3. **Run Android app** from the Actions tab and download the `.aab` from the run's Artifacts.
4. **Create the app** in [Play Console](https://play.google.com/console) → Create app, then upload that first `.aab` by hand under Testing → Internal testing. Google only accepts API uploads after the first manual one.
5. **Optional, automatic uploads.** In Google Cloud, create a service account with a JSON key, invite its email in Play Console → Users and permissions with release permissions for Family Quiz, and save the JSON as the `PLAY_SERVICE_ACCOUNT_JSON` secret. From then on each run sends a draft release to internal testing.

New personal Play developer accounts must run a closed test with at least 12 testers for 14 days before the app can go to production. Start that early.

## Store listing notes

- **Name.** "Family Quiz" alone is very likely taken on the App Store; pick a distinct store name. The name under the icon stays "Family Quiz".
- **Privacy answers.** App Store: Contact Info (email address) and User Content (names, ages of profiles, scores) linked to the user, for App Functionality only; Identifiers (the guest id) for App Functionality. No tracking. Google Play Data safety: the same, encrypted in transit, users can delete their account in the app.
- **Account deletion.** Account screen, "Delete my account", runs the `delete-account` edge function.
- **Children.** Kids play on a parent's phone or a parent-managed profile; they never give an email. Apple: rate it 4+, do not choose the Kids category (it restricts sign-in and links out). Google Play: children are in the target audience, so the Families policy applies; there are no ads or analytics, which keeps that simple.
- **Review notes for Apple.** No sign-in is needed: "One phone" plays a full quiz on one device. Mention the native features (haptics on marking, share sheet, screen kept awake). If the reviewer wants to try an account, give them a test login.
