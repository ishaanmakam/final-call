# Privacy policy

*Final Call · last updated 2026-11-07*

Final Call is a small app for friend groups who pledge to be somewhere by a time. This page says what the app collects, why, how long it is kept, who else sees it, and how to delete it. It is written to be read, not skimmed.

## What we collect

Only what the product needs to work:

- Account: your email address, or the identifier Apple gives us when you use Sign in with Apple (and the name Apple shares on the first sign-in, if you allow it).
- Profile: the display name you choose and, optionally, your Venmo username so friends can pay you at settle-up.
- Places: the spot you set for each pact (a coordinate, a radius of 25 to 500 m, and a label you type).
- Check-ins: one location fix each time you tap Check In inside an open window: coordinates, GPS accuracy, the time, and whether the fix looked simulated. The app never reads your location at any other time and has no background location access.
- Results and money records: whether each day counted as showed up, missed, unverified, frozen, void or excluded; the pledges forfeited and won in whole cents; weekly settle-up amounts between you and your friends; whether a payment was marked paid and confirmed.
- Reviews: the reason you type when you appeal or challenge a result, a photo you choose to attach as evidence, and votes.
- Device: a push notification token when you allow notifications; the app version and iOS version.
- Diagnostics (optional): if the build has crash reporting on, crash reports and performance samples go to Sentry with coordinates removed before they leave the phone.

## Why

To judge a check-in against the place you set, to show your group who showed up, to keep the tally of pledges, to send the reminders and results you asked for, and to let the group review a result. Nothing is used for advertising, and nothing is sold.

## What never happens

- No background location. Location is read only on the Check In tap inside an open window and when you set a place.
- No tracking across apps or websites; no advertising identifiers; no data brokers.
- No real money. Final Call never holds, moves or charges money. It keeps a tally of pledges between friends and gives you a Venmo link; Venmo is a separate app with its own terms.

## How long we keep it

- Raw check-in coordinates are deleted 30 days after the check-in. The distance to your place and the verdict are kept, because results and the tally are computed from them.
- Results, pledges, settle-ups and reviews are an append-only history shared with your group: they stay as long as the group exists, so everyone's balance can be recomputed.
- Push tokens are deleted when you turn notifications off, sign out, or delete your account, and when Apple reports the device is gone.
- Unsent notifications are deleted when they go stale; sent ones after 30 days.

## Who else sees it

- Your group: the members of a group see each other's names, Venmo usernames, places, check-in verdicts and distances, results, reviews, votes and the weekly tally. Raw coordinates are visible to nobody in the app.
- Supabase hosts the database, authentication and photo storage (the app's backend). Data is stored in the region the project was created in.
- Expo delivers push notifications (the notification text and a deep link, never your location).
- Sentry receives crash reports only in builds with crash reporting enabled, with coordinates stripped.
- Apple handles Sign in with Apple; Venmo is opened by a deep link you tap, with the amount and a note, and we never see your Venmo account.
- Nobody else, unless the law requires it.

## Your choices

- Notifications are optional (Settings → Notifications). The app works without them.
- Location permission can be revoked in iOS Settings; without it a Check In cannot be judged, and the day counts as missed, not unverified: that is your choice, not a tracking failure.
- Edit your name and Venmo username any time in Settings.
- Export: email us and we send you what we hold about you.

## Deleting your account

Settings → Delete account removes your account from inside the app: you leave every group, your sign-in identity (email or Apple id) and push tokens are erased, your name becomes "Deleted member" and your Venmo username is removed, your raw check-in coordinates, pending place changes and votes on open reviews are deleted. Past results, forfeits and settle-ups stay in your former groups' history under "Deleted member", because your friends' balances were computed from them. If you are in a check-in window that is open right now, the app asks you to try again after the deadline.

## Children

Final Call is for people 17 and older. We do not knowingly collect data from anyone younger; if you believe we have, email us and we will delete it.

## Changes and contact

When this policy changes, the date at the top changes and the app shows the new version. Questions, export or deletion requests: ishaan.makam@gmail.com.
