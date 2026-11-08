/**
 * Privacy policy and terms, as data: the two legal screens render these and `docs/legal/*.md` carry
 * the same text for the web (App Store Connect needs a URL). Change both together. No React Native
 * imports, so the wording is unit-testable (every money word stays "pledge / forfeit / pool").
 */

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDocument {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const LEGAL_CONTACT = 'ishaan.makam@gmail.com';
export const LEGAL_UPDATED = '2026-11-07';

export const PRIVACY: LegalDocument = {
  title: 'Privacy policy',
  updated: LEGAL_UPDATED,
  intro:
    'Final Call is a small app for friend groups who pledge to be somewhere by a time. This page says what the app collects, why, how long it is kept, who else sees it, and how to delete it. It is written to be read, not skimmed.',
  sections: [
    {
      heading: 'What we collect',
      paragraphs: ['Only what the product needs to work:'],
      bullets: [
        'Account: your email address, or the identifier Apple gives us when you use Sign in with Apple (and the name Apple shares on the first sign-in, if you allow it).',
        'Profile: the display name you choose and, optionally, your Venmo username so friends can pay you at settle-up.',
        'Places: the spot you set for each pact (a coordinate, a radius of 25 to 500 m, and a label you type).',
        'Check-ins: one location fix each time you tap Check In inside an open window: coordinates, GPS accuracy, the time, and whether the fix looked simulated. The app never reads your location at any other time and has no background location access.',
        'Results and money records: whether each day counted as showed up, missed, unverified, frozen, void or excluded; the pledges forfeited and won in whole cents; weekly settle-up amounts between you and your friends; whether a payment was marked paid and confirmed.',
        'Reviews: the reason you type when you appeal or challenge a result, a photo you choose to attach as evidence, and votes.',
        'Device: a push notification token when you allow notifications; the app version and iOS version.',
        'Diagnostics (optional): if the build has crash reporting on, crash reports and performance samples go to Sentry with coordinates removed before they leave the phone.',
      ],
    },
    {
      heading: 'Why',
      paragraphs: [
        'To judge a check-in against the place you set, to show your group who showed up, to keep the tally of pledges, to send the reminders and results you asked for, and to let the group review a result. Nothing is used for advertising, and nothing is sold.',
      ],
    },
    {
      heading: 'What never happens',
      bullets: [
        'No background location. Location is read only on the Check In tap inside an open window and when you set a place.',
        'No tracking across apps or websites; no advertising identifiers; no data brokers.',
        'No real money. Final Call never holds, moves or charges money. It keeps a tally of pledges between friends and gives you a Venmo link; Venmo is a separate app with its own terms.',
      ],
      paragraphs: [],
    },
    {
      heading: 'How long we keep it',
      bullets: [
        'Raw check-in coordinates are deleted 30 days after the check-in. The distance to your place and the verdict are kept, because results and the tally are computed from them.',
        'Results, pledges, settle-ups and reviews are an append-only history shared with your group: they stay as long as the group exists, so everyone\'s balance can be recomputed.',
        'Push tokens are deleted when you turn notifications off, sign out, or delete your account, and when Apple reports the device is gone.',
        'Unsent notifications are deleted when they go stale; sent ones after 30 days.',
      ],
      paragraphs: [],
    },
    {
      heading: 'Who else sees it',
      bullets: [
        'Your group: the members of a group see each other\'s names, Venmo usernames, places, check-in verdicts and distances, results, reviews, votes and the weekly tally. Raw coordinates are visible to nobody in the app.',
        'Supabase hosts the database, authentication and photo storage (the app\'s backend). Data is stored in the region the project was created in.',
        'Expo delivers push notifications (the notification text and a deep link, never your location).',
        'Sentry receives crash reports only in builds with crash reporting enabled, with coordinates stripped.',
        'Apple handles Sign in with Apple; Venmo is opened by a deep link you tap, with the amount and a note, and we never see your Venmo account.',
        'Nobody else, unless the law requires it.',
      ],
      paragraphs: [],
    },
    {
      heading: 'Your choices',
      bullets: [
        'Notifications are optional (Settings → Notifications). The app works without them.',
        'Location permission can be revoked in iOS Settings; without it a Check In cannot be judged, and the day counts as missed, not unverified: that is your choice, not a tracking failure.',
        'Edit your name and Venmo username any time in Settings.',
        'Export: email us and we send you what we hold about you.',
      ],
      paragraphs: [],
    },
    {
      heading: 'Deleting your account',
      paragraphs: [
        'Settings → Delete account removes your account from inside the app: you leave every group, your sign-in identity (email or Apple id) and push tokens are erased, your name becomes "Deleted member" and your Venmo username is removed, your raw check-in coordinates, pending place changes and votes on open reviews are deleted. Past results, forfeits and settle-ups stay in your former groups\' history under "Deleted member", because your friends\' balances were computed from them. If you are in a check-in window that is open right now, the app asks you to try again after the deadline.',
      ],
    },
    {
      heading: 'Children',
      paragraphs: ['Final Call is for people 17 and older. We do not knowingly collect data from anyone younger; if you believe we have, email us and we will delete it.'],
    },
    {
      heading: 'Changes and contact',
      paragraphs: [
        `When this policy changes, the date at the top changes and the app shows the new version. Questions, export or deletion requests: ${LEGAL_CONTACT}.`,
      ],
    },
  ],
};

export const TERMS: LegalDocument = {
  title: 'Terms of use',
  updated: LEGAL_UPDATED,
  intro:
    'Short version: Final Call is a scorekeeper for promises between friends. It does not handle money, it is not gambling, and the people in your group, not the app, decide what is fair.',
  sections: [
    {
      heading: 'What Final Call is',
      paragraphs: [
        'A group of friends agrees on a pact: a place, a deadline, days of the week, and a pledge in dollars (one cent to one hundred dollars). Each person checks in with one tap inside the window; the app records whether the tap landed inside the place they set. People who showed up split the pledges of people who missed. Once a week the app totals it up and shows who owes whom.',
      ],
    },
    {
      heading: 'No real money',
      paragraphs: [
        'Final Call never collects, holds, transfers or charges money and has no payment processor. The tally is an IOU between friends; settling it is between you, through Venmo or any way you agree, and is voluntary. The app is not a wallet, bank, escrow, payment service or betting operator, and nothing in it is a financial product.',
      ],
    },
    {
      heading: 'Not gambling',
      paragraphs: [
        'Outcomes depend entirely on your own actions: being where you said you would be. There is no chance, no house, no rake and no fee of any kind. Pledges are capped at $100 per person per day. Do not use the app where keeping such a tally between friends would be unlawful.',
      ],
    },
    {
      heading: 'Fair play',
      bullets: [
        'A tracking or connectivity failure (weak GPS, no fix, no network, a late delivery) resolves to Unverified and never costs anyone a pledge.',
        'Turning Precise Location off or refusing location is a choice, not a failure: such a day counts as missed.',
        'Simulated or spoofed locations are rejected; repeated attempts may get a result challenged by the group.',
        'Places are visible to the whole group. A changed place counts only after another member confirms it or 24 hours pass, and any member can object within 24 hours of it being set.',
        'Results can be reviewed before Monday\'s settle-up: you may appeal your own missed day; others may challenge a showed-up or unverified day. The group votes; a majority of votes cast decides, ties and silence keep the result.',
        'More than two unverified days in a pact in a month opens a group review automatically.',
      ],
      paragraphs: [],
    },
    {
      heading: 'Your account',
      paragraphs: [
        'You need to be 17 or older. Keep your sign-in method (email or Apple id) to yourself; you are responsible for what is done with your account. You can delete it at any time from Settings (see the privacy policy for what stays as group history).',
      ],
    },
    {
      heading: 'Your content',
      paragraphs: [
        'Names, place labels, review reasons and photos are yours. You give us permission to store and show them to your group so the app can work. Do not post anything unlawful, hateful, or that is not yours to share. We can remove content and close accounts that break these rules.',
      ],
    },
    {
      heading: 'Groups and leaving',
      paragraphs: [
        'You can leave a group at any time except while a check-in window you are part of is open. Leaving does not cancel what you already owe or are owed from settled weeks; those rows stay visible to you and the other party.',
      ],
    },
    {
      heading: 'No warranty, limited liability',
      paragraphs: [
        'The app is provided as is. GPS, networks and phones fail, and the rules above are designed so that such failures do not cost anyone a pledge, but we do not promise the app will always be available or error-free. To the extent the law allows, we are not liable for any loss arising from use of the app, including disagreements between friends about who owes whom.',
      ],
    },
    {
      heading: 'Termination and changes',
      paragraphs: [
        `We may suspend or close accounts that abuse the service or other people, and may change or discontinue the app. When these terms change, the date at the top changes. Questions: ${LEGAL_CONTACT}.`,
      ],
    },
  ],
};

/** Markdown rendering shared by the docs/legal files (kept in sync by a test). */
export function legalMarkdown(doc: LegalDocument): string {
  const out: string[] = [`# ${doc.title}`, '', `*Final Call · last updated ${doc.updated}*`, '', doc.intro, ''];
  for (const s of doc.sections) {
    out.push(`## ${s.heading}`, '');
    for (const p of s.paragraphs) out.push(p, '');
    if (s.bullets) {
      for (const b of s.bullets) out.push(`- ${b}`);
      out.push('');
    }
  }
  return out.join('\n');
}
