/**
 * channel-config.ts — what each delivery channel needs from the user, as data.
 *
 * ONE declaration feeds three things that would otherwise drift apart: the
 * settings records that render the inputs, the API that validates a write, and
 * the allow-list that stops user_secrets growing unbounded jsonb. A channel that
 * grows a field adds it here and nowhere else.
 *
 * The split between `config` and `secrets` is a security boundary, not a
 * grouping. Anything in `config` lands in user_extensions (RLS'd to the owner,
 * so the browser reads it back and the settings page can show it). Anything in
 * `secrets` lands in user_secrets, which has its grants revoked from
 * authenticated entirely — the settings page is told only whether a key is SET.
 * Putting a token in the wrong list would silently make it readable, so the
 * lists are the thing to be careful about, not the UI.
 */

export interface ChannelField {
  /** Key inside the channel's config or secrets object. */
  key: string
  label: string
  placeholder?: string
  /** Shown under the input. Say what it is and where to get it. */
  description?: string
  /**
   * Extra search terms for this field alone, on top of its channel's.
   *
   * Hand-authored and deliberately NOT derived from the label — search indexes
   * labels already, so a keyword that restates one adds nothing and trips the
   * manifest's own "never just the label" rule.
   */
  keywords?: string[]
}

export interface ChannelSettingsSpec {
  /** Identical to the extension slug AND the NudgeChannel slug. */
  slug: string
  /**
   * Search terms for every record this channel generates — the words someone
   * uses when they are looking for it, not the words in the code.
   *
   * Hand-authored rather than derived from the labels, which is the rule the
   * settings manifest states outright: deriving keywords from labels is what
   * makes search feel broken, because nobody types "Account SID" when what
   * they want is "twilio".
   */
  keywords: string[]
  /** Rendered under the extension's toggle, in order. */
  config: ChannelField[]
  /** Credentials. Write-only from the browser's point of view. */
  secrets: ChannelField[]
}

export const CHANNEL_SETTINGS: ChannelSettingsSpec[] = [
  {
    slug: 'voice-announcements',
    keywords: ['home assistant', 'speaker', 'sonos', 'alexa', 'aloud', 'tts', 'announce', 'voice', 'kitchen'],
    config: [
      {
        key: 'baseUrl',
        label: 'Home Assistant URL',
        placeholder: 'https://home.example.com',
        // Worth saying, because the obvious value is the one that cannot work:
        // dsul calls this from a server, not from your browser.
        description:
          'Must be reachable from the internet. dsul calls it from its own server, so a LAN address only works on a self-hosted dsul.',
      },
      {
        key: 'players',
        label: 'Speakers',
        keywords: ['media_player', 'entity', 'room', 'which speaker'],
        placeholder: 'media_player.kitchen, media_player.office',
        description: 'Comma-separated media_player entity ids.',
      },
      {
        key: 'ttsEntity',
        label: 'Voice entity',
        placeholder: 'tts.google_translate_say',
        description: 'The tts.* entity to speak through. Blank uses Home Assistant’s default.',
      },
      {
        key: 'kinds',
        label: 'Speak',
        placeholder: 'cue, last-call',
        description: 'Blank means both. Use "last-call" alone to keep the house quiet all day.',
      },
    ],
    secrets: [
      {
        key: 'token',
        label: 'Long-lived access token',
        description: 'Home Assistant → your profile → Long-lived access tokens. Stored where the browser cannot read it back.',
      },
    ],
  },
  {
    slug: 'sms-nudge',
    keywords: ['twilio', 'text', 'sms', 'message', 'phone', 'number'],
    config: [
      { key: 'to', label: 'Your number', placeholder: '+15551234567', description: 'E.164 format.', keywords: ['my number', 'mobile', 'cell', 'recipient'] },
      { key: 'from', label: 'Twilio number', placeholder: '+15557654321', keywords: ['sender', 'caller id', 'origin'] },
      { key: 'kinds', label: 'Text me for', placeholder: 'cue, last-call', description: 'Blank means both.' },
    ],
    secrets: [
      { key: 'accountSid', label: 'Account SID', description: 'From the Twilio console.' },
      { key: 'authToken', label: 'Auth token', description: 'Write-only. dsul never shows it again.' },
    ],
  },
  {
    slug: 'phone-call',
    keywords: ['twilio', 'call', 'phone', 'ring', 'voice', 'dial'],
    config: [
      { key: 'to', label: 'Your number', placeholder: '+15551234567', description: 'E.164 format.', keywords: ['my number', 'mobile', 'cell', 'recipient'] },
      { key: 'from', label: 'Twilio number', placeholder: '+15557654321', keywords: ['sender', 'caller id', 'origin'] },
      {
        key: 'kinds',
        label: 'Call me for',
        placeholder: 'last-call',
        // The default is stated because it is unusually consequential, and
        // because someone who types "cue" here should know what they are asking
        // for before the phone rings at 07:30.
        description: 'Defaults to last call only. Add "cue" to be called for every reminder.',
      },
      {
        key: 'voice',
        // "Speaking voice", not "Voice": the channel's own search terms include
        // "voice" (as in voice call), and a field labelled the same word is
        // both ambiguous on screen and a keyword collision in the index.
        label: 'Speaking voice',
        placeholder: 'alice',
        description: 'A Twilio text-to-speech voice name.',
        keywords: ['accent', 'tts', 'reader', 'speech'],
      },
    ],
    secrets: [
      { key: 'accountSid', label: 'Account SID', description: 'From the Twilio console.' },
      { key: 'authToken', label: 'Auth token', description: 'Write-only. dsul never shows it again.' },
    ],
  },
]

/*
 * The lookup helpers that used to live here moved to lib/extension-settings.ts
 * when the stake adapters arrived with the same shape: a consumer that resolved
 * a slug against THIS list alone would silently fail to find every stakes
 * field, which is the exact drift the single declaration exists to prevent.
 */
