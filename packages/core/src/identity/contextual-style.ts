/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Contextual Identity Style
 *
 * The agent adapts communication style based on context.
 * Same identity, different register. The core personality stays
 * constant — what changes is verbosity, formality, emoji usage,
 * and tone directives.
 *
 * Context factors:
 * - Channel-based: Telegram (casual), Discord (community), Email (formal), Dashboard (technical)
 * - Time-based: morning (energetic), late night (subdued)
 * - User-based: new user (more explanation), experienced user (concise)
 * - Conversation-based: first message (introductory), deep conversation (assumes context)
 * - Emotional: detected frustration (empathetic), detected urgency (direct)
 */

import { Logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StyleContext {
  /** Communication channel (e.g., 'telegram', 'discord', 'email', 'dashboard') */
  channel: string;
  /** Time of day */
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  /** User interaction history */
  userHistory: {
    messagesExchanged: number;
    firstInteraction: boolean;
  };
  /** How deep into the conversation (message count in current session) */
  conversationDepth: number;
  /** Detected tone from user's message */
  detectedTone?: 'neutral' | 'urgent' | 'frustrated' | 'curious' | 'happy';
}

export type Verbosity = 'concise' | 'normal' | 'detailed';
export type Formality = 'casual' | 'professional' | 'formal';
export type EmojiUsage = 'none' | 'minimal' | 'moderate';

export interface StyleProfile {
  /** Profile name */
  name: string;
  /** How verbose responses should be */
  verbosity: Verbosity;
  /** Level of formality */
  formality: Formality;
  /** Emoji usage level */
  emojiUsage: EmojiUsage;
  /** Directive text added to system prompt */
  directive: string;
}

export interface StyleFeedback {
  sessionId: string;
  feedback: string;
  timestamp: string;
  profileUsed: string;
}

// ─── Predefined Style Profiles ───────────────────────────────────────────────

const PROFILES: Record<string, StyleProfile> = {
  casual: {
    name: 'casual',
    verbosity: 'normal',
    formality: 'casual',
    emojiUsage: 'moderate',
    directive: 'Communicate casually. Use a friendly, relaxed tone. Emoji are welcome. Keep responses conversational and approachable.',
  },
  formal: {
    name: 'formal',
    verbosity: 'normal',
    formality: 'formal',
    emojiUsage: 'none',
    directive: 'Communicate formally. Use professional language and proper structure. No emoji. Be precise and thorough.',
  },
  technical: {
    name: 'technical',
    verbosity: 'detailed',
    formality: 'professional',
    emojiUsage: 'minimal',
    directive: 'Communicate with technical precision. Include relevant details, metrics, and data. Use proper terminology. Minimal emoji.',
  },
  concise: {
    name: 'concise',
    verbosity: 'concise',
    formality: 'professional',
    emojiUsage: 'minimal',
    directive: 'Be concise. Get to the point quickly. Avoid unnecessary explanation. Short sentences. Bullet points preferred.',
  },
  empathetic: {
    name: 'empathetic',
    verbosity: 'normal',
    formality: 'casual',
    emojiUsage: 'minimal',
    directive: 'Be empathetic and patient. Acknowledge the user\'s feelings. Show understanding before providing solutions. Be warm but not overbearing.',
  },
  energetic: {
    name: 'energetic',
    verbosity: 'normal',
    formality: 'casual',
    emojiUsage: 'moderate',
    directive: 'Be energetic and enthusiastic. Show initiative. Use dynamic language. Be proactive and positive.',
  },
};

// ─── Channel Defaults ───────────────────────────────────────────────────────

const CHANNEL_DEFAULTS: Record<string, string> = {
  telegram: 'casual',
  discord: 'casual',
  email: 'formal',
  dashboard: 'technical',
  webchat: 'casual',
  api: 'technical',
};

// ─── Tone Detection Patterns ───────────────────────────────────────────────

const TONE_PATTERNS: Array<{ tone: NonNullable<StyleContext['detectedTone']>; patterns: RegExp[] }> = [
  {
    tone: 'urgent',
    patterns: [
      /\b(?:urgent|asap|emergency|critical|now|immediately|right away|deadline)\b/i,
      /\b(?:broken|down|not working|crash|fail|error)\b/i,
      /!{2,}/,
    ],
  },
  {
    tone: 'frustrated',
    patterns: [
      /\b(?:frustrated|annoyed|irritated|fed up|sick of|tired of|this is ridiculous|not again)\b/i,
      /\b(?:doesn't work|still broken|why is|why does|not helpful|useless)\b/i,
      /\b(ugh|argh|come on|seriously)\b/i,
    ],
  },
  {
    tone: 'curious',
    patterns: [
      /\b(?:curious|wondering|interesting|tell me more|what if|how does|why does|interesting)\b/i,
      /\?{2,}/,
    ],
  },
  {
    tone: 'happy',
    patterns: [
      /\b(?:great|awesome|perfect|excellent|fantastic|love it|amazing|wonderful|brilliant)\b/i,
      /\b(?:thank you|thanks|appreciate|grateful)\b/i,
      /!{1,}(?:\s|$)/,
    ],
  },
];

// ─── Contextual Style System ─────────────────────────────────────────────────

export interface ContextualStyleConfig {
  /** Logger instance (optional) */
  logger?: Logger;
  /** Maximum style history to keep */
  maxHistory?: number;
  /** Override channel defaults */
  channelOverrides?: Record<string, string>;
}

export class ContextualStyle {
  private config: ContextualStyleConfig;
  private logger: Logger;
  private styleHistory: StyleProfile[] = [];
  private feedbackHistory: StyleFeedback[] = [];
  private learnedAdjustments: Map<string, Partial<StyleProfile>> = new Map();

  constructor(config: ContextualStyleConfig = {}) {
    this.config = {
      maxHistory: 100,
      ...config,
    };
    this.logger = config.logger ?? new Logger({ minLevel: 'info' });
  }

  /**
   * Determine the appropriate style profile for the given context.
   * Combines channel defaults, time-of-day, user history, conversation depth,
   * and detected tone into a single profile.
   */
  getStyle(context: StyleContext): StyleProfile {
    // 1. Start with channel default
    const channelDefaults = { ...CHANNEL_DEFAULTS, ...(this.config.channelOverrides || {}) };
    let baseProfileName = channelDefaults[context.channel] || 'casual';
    let profile = { ...PROFILES[baseProfileName] };

    // 2. Adjust for time of day
    profile = this.adjustForTimeOfDay(profile, context.timeOfDay);

    // 3. Adjust for user history
    profile = this.adjustForUserHistory(profile, context.userHistory);

    // 4. Adjust for conversation depth
    profile = this.adjustForConversationDepth(profile, context.conversationDepth);

    // 5. Adjust for detected tone (overrides everything else)
    if (context.detectedTone) {
      profile = this.adjustForTone(profile, context.detectedTone);
    }

    // 6. Apply learned adjustments
    const channelKey = context.channel;
    const learned = this.learnedAdjustments.get(channelKey);
    if (learned) {
      profile = { ...profile, ...learned };
    }

    // Record in history
    this.styleHistory.push(profile);
    if (this.styleHistory.length > (this.config.maxHistory ?? 100)) {
      this.styleHistory = this.styleHistory.slice(-((this.config.maxHistory ?? 100)));
    }

    this.logger.debug(`[ContextualStyle] Style selected: ${profile.name}`, {
      channel: context.channel,
      timeOfDay: context.timeOfDay,
      tone: context.detectedTone || 'neutral',
      verbosity: profile.verbosity,
      formality: profile.formality,
    });

    return profile;
  }

  /**
   * Apply a style profile to a system prompt.
   * Adds the style directive at the end of the system prompt.
   */
  applyStyle(systemPrompt: string, style: StyleProfile): string {
    const directiveBlock = `\n\n## Communication Style\n${style.directive}\nVerbosity: ${style.verbosity}. Formality: ${style.formality}. Emoji: ${style.emojiUsage}.`;

    return systemPrompt + directiveBlock;
  }

  /**
   * Learn from user feedback about style.
   * Adjusts future style selections for the channel.
   */
  learnStylePreference(sessionId: string, feedback: string): void {
    const feedbackLower = feedback.toLowerCase();
    const timestamp = new Date().toISOString();

    // Get the last used profile
    const lastProfile = this.styleHistory[this.styleHistory.length - 1];
    const profileName = lastProfile?.name || 'casual';

    this.feedbackHistory.push({ sessionId, feedback, timestamp, profileUsed: profileName });
    if (this.feedbackHistory.length > 50) {
      this.feedbackHistory = this.feedbackHistory.slice(-50);
    }

    // Parse feedback and adjust
    const adjustments: Partial<StyleProfile> = {};

    if (/\btoo verbose|too long|too wordy|too much detail\b/i.test(feedback)) {
      adjustments.verbosity = 'concise';
      this.logger.info(`[ContextualStyle] Learned: reduce verbosity based on feedback`);
    } else if (/\btoo short|too brief|need more detail|more detail|too concise\b/i.test(feedback)) {
      adjustments.verbosity = 'detailed';
      this.logger.info(`[ContextualStyle] Learned: increase verbosity based on feedback`);
    }

    if (/\btoo formal|too stiff|too professional|loosen up|be more casual\b/i.test(feedback)) {
      adjustments.formality = 'casual';
      this.logger.info(`[ContextualStyle] Learned: reduce formality based on feedback`);
    } else if (/\btoo casual|too informal|be more professional|be more formal\b/i.test(feedback)) {
      adjustments.formality = 'formal';
      this.logger.info(`[ContextualStyle] Learned: increase formality based on feedback`);
    }

    if (/\btoo many emoji|too much emoji|less emoji|no emoji\b/i.test(feedback)) {
      adjustments.emojiUsage = 'none';
      this.logger.info(`[ContextualStyle] Learned: reduce emoji based on feedback`);
    } else if (/\bmore emoji|use emoji\b/i.test(feedback)) {
      adjustments.emojiUsage = 'moderate';
      this.logger.info(`[ContextualStyle] Learned: increase emoji based on feedback`);
    }

    // Apply adjustments to the channel
    if (Object.keys(adjustments).length > 0) {
      // Infer channel from session (we'd need a session-to-channel mapping)
      // For now, apply to the last used channel. In practice, the engine
      // would pass the channel along with feedback.
      // We store adjustments keyed by profile name for now
      const key = profileName;
      const existing = this.learnedAdjustments.get(key) || {};
      this.learnedAdjustments.set(key, { ...existing, ...adjustments });
    }
  }

  /**
   * Get recent style profiles used.
   */
  getStyleHistory(): StyleProfile[] {
    return [...this.styleHistory];
  }

  /**
   * Get feedback history.
   */
  getFeedbackHistory(): StyleFeedback[] {
    return [...this.feedbackHistory];
  }

  /**
   * Detect tone from a user message.
   * Returns the detected tone or null if no clear tone.
   */
  detectTone(message: string): NonNullable<StyleContext['detectedTone']> | undefined {
    for (const { tone, patterns } of TONE_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          return tone;
        }
      }
    }
    return undefined;
  }

  /**
   * Get a predefined profile by name.
   */
  getProfile(name: string): StyleProfile | undefined {
    return PROFILES[name] ? { ...PROFILES[name] } : undefined;
  }

  /**
   * Get all available predefined profile names.
   */
  listProfiles(): string[] {
    return Object.keys(PROFILES);
  }

  // ─── Private: Adjustment Functions ──────────────────────────────────────

  private adjustForTimeOfDay(profile: StyleProfile, timeOfDay: StyleContext['timeOfDay']): StyleProfile {
    switch (timeOfDay) {
      case 'morning':
        // Morning: slightly more energetic
        if (profile.verbosity === 'concise') return profile;
        return {
          ...profile,
          directive: profile.directive + ' It\'s morning — be fresh and energetic.',
        };
      case 'afternoon':
        // Afternoon: normal
        return profile;
      case 'evening':
        // Evening: slightly more subdued
        return {
          ...profile,
          directive: profile.directive + ' It\'s evening — be calm and measured.',
        };
      case 'night':
        // Late night: subdued, brief
        return {
          ...profile,
          verbosity: profile.verbosity === 'detailed' ? 'normal' : profile.verbosity,
          directive: profile.directive + ' It\'s late at night — be brief and quiet. The user may be tired.',
        };
      default:
        return profile;
    }
  }

  private adjustForUserHistory(
    profile: StyleProfile,
    userHistory: StyleContext['userHistory']
  ): StyleProfile {
    if (userHistory.firstInteraction) {
      // New user: more explanation
      return {
        ...profile,
        verbosity: profile.verbosity === 'concise' ? 'normal' : profile.verbosity,
        directive: profile.directive + ' This is a new user — explain things a bit more than usual. Introduce yourself briefly if appropriate.',
      };
    }

    if (userHistory.messagesExchanged > 100) {
      // Very experienced user: be concise
      return {
        ...profile,
        verbosity: profile.verbosity === 'detailed' ? 'normal' : 'concise',
        directive: profile.directive + ' This is an experienced user — skip basic explanations and get to the point.',
      };
    }

    return profile;
  }

  private adjustForConversationDepth(profile: StyleProfile, depth: number): StyleProfile {
    if (depth === 0 || depth === 1) {
      // First message: introductory
      return {
        ...profile,
        directive: profile.directive + ' This is the start of a conversation — provide context if making references.',
      };
    }

    if (depth > 20) {
      // Deep conversation: assume context
      return {
        ...profile,
        verbosity: profile.verbosity === 'detailed' ? 'normal' : profile.verbosity,
        directive: profile.directive + ' Deep in conversation — assume context, don\'t repeat established information.',
      };
    }

    return profile;
  }

  private adjustForTone(
    profile: StyleProfile,
    tone: NonNullable<StyleContext['detectedTone']>
  ): StyleProfile {
    switch (tone) {
      case 'frustrated':
        // Frustrated user: empathetic, concise, no emoji
        return {
          ...PROFILES.empathetic,
          verbosity: 'concise',
          emojiUsage: 'none',
          directive: PROFILES.empathetic.directive + ' The user seems frustrated — acknowledge their frustration first, then provide a clear, concise solution. No emoji.',
        };
      case 'urgent':
        // Urgent: direct, concise, no fluff
        return {
          ...profile,
          verbosity: 'concise',
          formality: 'professional',
          emojiUsage: 'none',
          directive: 'Be direct and efficient. The user has an urgent need. Cut to the solution immediately. No pleasantries.',
        };
      case 'curious':
        // Curious: detailed, enthusiastic
        return {
          ...profile,
          verbosity: 'detailed',
          emojiUsage: 'minimal',
          directive: profile.directive + ' The user is curious — provide rich, detailed answers. Share related insights. Encourage exploration.',
        };
      case 'happy':
        // Happy: match the energy
        return {
          ...profile,
          emojiUsage: 'moderate',
          directive: profile.directive + ' The user is in a good mood — match their positive energy. Be warm and engaging.',
        };
      case 'neutral':
      default:
        return profile;
    }
  }
}