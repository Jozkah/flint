# Flint for iPhone (sideloaded)

The iPhone app is a thin client: it shows the same chats, rooms and studio you
have in Flint on your computer and talks to that computer over your network.
Nothing runs on the phone. It is not on the App Store; you install it yourself
with a free Apple ID.

## What you need

- Flint on a computer (or the headless server) with **Remote access** turned on.
- An iPhone that can reach that computer: same Wi-Fi, or a VPN such as Tailscale.
- A way to install it: AltStore, SideStore or Sideloadly, or xtool on the command line.

## Install

Download `Flint-unsigned.ipa` from the latest **iOS IPA** workflow run
(Actions → iOS IPA → the run's *Flint-unsigned-ipa* artifact). Then pick one
of the tools below. Each signs the app for your phone with your own Apple ID,
which is why the file in the artifact is unsigned.

### AltStore, SideStore or Sideloadly

Open the `.ipa` in the tool and sign in with your Apple ID. AltStore and
SideStore refresh the app in the background while your phone can reach them.

### xtool (Windows via WSL, Linux, macOS)

[xtool](https://github.com/xtool-org/xtool) installs an existing `.ipa` from
the command line, with no Mac and no iTunes-based sideloader:

```bash
xtool auth login                  # Apple ID (or an App Store Connect API key)
xtool install Flint-unsigned.ipa  # signs and installs over USB
xtool launch                      # optional: start it from the terminal
xtool uninstall                   # remove it again
```

On Windows run it inside WSL with USB passthrough set up as described in
xtool's installation guide. `xtool install` only needs the login; the
`xtool sdk` step (which wants an `Xcode.xip`) is for building Swift apps, not
for installing this one. xtool cannot *build* Flint's iPhone app, which is a
Rust and Tauri project; the IPA comes from CI.

### Trust and expiry

On the phone: Settings → General → VPN & Device Management → trust your Apple
ID. A free Apple ID signs an app for **7 days**; install it again (or let
AltStore/SideStore refresh it) before then. A free account can have three
sideloaded apps at once.

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
