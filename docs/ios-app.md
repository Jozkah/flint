# Flint for iPhone (sideloaded)

The iPhone app is a thin client: it shows the same chats, rooms and studio you
have in Flint on your computer and talks to that computer over your network.
Nothing runs on the phone. It is not on the App Store; you install it yourself
with a free Apple ID.

## What you need

- Flint on a computer (or the headless server) with **Remote access** turned on.
- An iPhone that can reach that computer: same Wi-Fi, or a VPN such as Tailscale.
- One of AltStore, SideStore or Sideloadly on your own computer or phone.

## Install

1. Download `Flint-unsigned.ipa` from the latest **iOS IPA** workflow run
   (Actions → iOS IPA → the run's *Flint-unsigned-ipa* artifact).
2. Open it in AltStore, SideStore or Sideloadly and sign in with your Apple ID.
   The tool re-signs the app for your phone.
3. On the phone: Settings → General → VPN & Device Management → trust your
   Apple ID.

A free Apple ID signs an app for **7 days**. AltStore and SideStore refresh it
in the background while your phone can reach them; otherwise, install it again.
A free account can have three sideloaded apps at once.

## Connect

1. In Flint on your computer: Settings → Remote access → turn it on.
2. Open the app on the phone and enter the computer's address (for example
   `192.168.1.20:1340`), or paste the pairing link from the QR code.
3. iOS asks to allow access to the local network. Allow it.
4. Confirm the pairing number shown on both screens.

The app remembers the computer's certificate the first time it connects and
refuses any other one after that. If you reset the computer's certificate on
purpose, choose **Trust this computer's new certificate** on the connect screen.

## Limits

- No push notifications: they need a paid developer account. Open the app to
  see new activity.
- The computer has to be on and reachable. There is no model running on the
  phone.
- The app lives and dies by the computer's Remote access listener; the phone web
  client at `https://<computer>:<port>/m/` keeps working in Safari as before.

## Building it yourself

```bash
yarn install
yarn build:icon
yarn build:ios:shell        # the phone client, laid out for the app shell
yarn tauri ios init
yarn tauri ios build -- --no-default-features --features mobile
```

This needs macOS with Xcode. The CI workflow `.github/workflows/ios-ipa.yml`
does the same on a hosted Mac and removes the signing settings so the result
can be re-signed with any Apple ID.
