/**
 * stake-config.ts — what each stake adapter needs from the user, as data.
 *
 * The stakes twin of lib/reminders/channel-config.ts, and the same shape on
 * purpose: one declaration feeds the settings records, the API's write
 * allow-list and the docs, so the page cannot offer a field the server rejects.
 */

import type { ChannelSettingsSpec } from '../reminders/channel-config'

export const STAKE_SETTINGS: ChannelSettingsSpec[] = [
  {
    slug: 'beeminder',
    keywords: ['beeminder', 'stake', 'money', 'pledge', 'derail', 'graph', 'goal', 'commitment'],
    config: [
      { key: 'username', label: 'Beeminder username', placeholder: 'yourname' },
      {
        key: 'goals',
        label: 'Habit → goal',
        placeholder: 'Vitamins: vitamins, Reading: read',
        // The rename caveat is stated where someone can act on it, because the
        // failure is silent: the datapoint simply stops being posted.
        description:
          'Matched on the habit’s title, so update this if you rename one. Only completions are posted. A miss is the missing datapoint, which is what makes the goal derail. Each one goes up the moment you tick the box; un-ticking withdraws it again.',
        keywords: ['mapping', 'slug', 'which goal', 'link'],
      },
    ],
    secrets: [
      { key: 'authToken', label: 'Auth token', description: 'Beeminder → Settings → Account → API credentials.' },
    ],
  },
  {
    slug: 'pledge',
    keywords: ['pledge', 'stake', 'anti-charity', 'money', 'fine', 'penalty', 'owe', 'commitment', 'contract'],
    config: [
      {
        key: 'amount',
        label: 'Per miss',
        placeholder: '10',
        description: 'What one missed habit costs. dsul records it but cannot take payment.',
        keywords: ['cost', 'price', 'how much', 'amount'],
      },
      { key: 'currency', label: 'Currency', placeholder: 'USD', keywords: ['gbp', 'eur', 'usd', 'money'] },
      {
        key: 'charity',
        label: 'Payable to',
        placeholder: 'a cause you can’t stand',
        // Naming the mechanism, because the obvious choice is the weak one.
        description: 'Somewhere you would hate to fund. A cause you like makes this a donation, not a stake.',
        keywords: ['anti-charity', 'who', 'recipient', 'cause'],
      },
      {
        key: 'witnessUrl',
        label: 'Witness webhook',
        placeholder: 'https://hooks.slack.com/…',
        description: 'Optional. A Slack or Discord webhook that also gets told what you owe.',
        keywords: ['slack', 'discord', 'webhook', 'tell someone', 'public'],
      },
    ],
    secrets: [],
  },
  {
    slug: 'accountability-partner',
    keywords: ['partner', 'accountability', 'friend', 'coach', 'digest', 'slack', 'discord', 'webhook', 'report'],
    config: [
      {
        key: 'webhookUrl',
        label: 'Webhook',
        placeholder: 'https://hooks.slack.com/…',
        description: 'A Slack or Discord webhook, usually for a channel you share with them.',
        keywords: ['slack', 'discord', 'url', 'channel'],
      },
      {
        key: 'name',
        label: 'Your name',
        placeholder: 'Kirby',
        description: 'How the digest refers to you, since someone else is reading it.',
        keywords: ['who', 'label', 'whose'],
      },
    ],
    secrets: [],
  },
]
