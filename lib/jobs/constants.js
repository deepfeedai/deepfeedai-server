'use strict';

// ── Job types ────────────────────────────────────────────────────────────────
// To add a new type: (1) add here, (2) update jobs_type_check CHECK constraint
// via ALTER TABLE, (3) add to CATEGORY_MAP, PRIORITY, MAX_ATTEMPTS, STALE_MINUTES.
const JOB_TYPE = {
  // Content generation
  SYNTHESIZE:        'synthesize',
  DEEP_DIVE:         'deep_dive',
  TOPIC_BRIEF:       'topic_brief',
  EDITORIAL_REVIEW:  'editorial_review',

  // Media
  GENERATE_IMAGE:      'generate_image',
  GENERATE_AUDIO:      'generate_audio',
  GENERATE_EMBEDDING:  'generate_embedding',

  // Writer comms
  PITCH_WRITER:    'pitch_writer',
  WRITER_FOLLOWUP: 'writer_followup',

  // Notifications
  NOTIFY_DISCORD:  'notify_discord',
  NOTIFY_TELEGRAM: 'notify_telegram',
  NOTIFY_SLACK:    'notify_slack',
  NOTIFY_EMAIL:    'notify_email',

  // Publishing
  PUBLISH_ARTICLE: 'publish_article',

  // Ingestion
  INGEST_EXTERNAL: 'ingest_external',

  // Maintenance
  BACKFILL_TAGS:         'backfill_tags',
  BACKFILL_EMBEDDINGS:   'backfill_embeddings',
  MAINTENANCE_PURGE:     'maintenance_purge',
  MAINTENANCE_VACUUM:    'maintenance_vacuum',
};

// ── Categories ───────────────────────────────────────────────────────────────
const JOB_CATEGORY = {
  CONTENT_GEN:   'content_gen',
  MEDIA:         'media',
  WRITER_COMMS:  'writer_comms',
  NOTIFICATIONS: 'notifications',
  PUBLISHING:    'publishing',
  INGESTION:     'ingestion',
  MAINTENANCE:   'maintenance',
};

// type → category lookup (used by enqueueJob)
const CATEGORY_MAP = {
  synthesize:          'content_gen',
  deep_dive:           'content_gen',
  topic_brief:         'content_gen',
  editorial_review:    'content_gen',
  generate_image:      'media',
  generate_audio:      'media',
  generate_embedding:  'media',
  pitch_writer:        'writer_comms',
  writer_followup:     'writer_comms',
  notify_discord:      'notifications',
  notify_telegram:     'notifications',
  notify_slack:        'notifications',
  notify_email:        'notifications',
  publish_article:     'publishing',
  ingest_external:     'ingestion',
  backfill_tags:       'maintenance',
  backfill_embeddings: 'maintenance',
  maintenance_purge:   'maintenance',
  maintenance_vacuum:  'maintenance',
};

// ── Priority ─────────────────────────────────────────────────────────────────
// Lower integer = higher urgency. Poll query: ORDER BY priority ASC.
const PRIORITY = {
  URGENT:     10,  // scheduled publish <5min, breaking dispatch
  HIGH:       20,  // notifications, editorial review (user is waiting)
  NORMAL:     30,  // synthesis, media gen, pitches
  LOW:        40,  // embeddings, writer follow-up, ingestion
  BACKGROUND: 50,  // backfill, maintenance
};

// type → default priority
const JOB_PRIORITY = {
  synthesize:         PRIORITY.NORMAL,
  deep_dive:          PRIORITY.NORMAL,
  topic_brief:        PRIORITY.NORMAL,
  editorial_review:   PRIORITY.HIGH,
  generate_image:     PRIORITY.NORMAL,
  generate_audio:     PRIORITY.NORMAL,
  generate_embedding: PRIORITY.LOW,
  pitch_writer:       PRIORITY.NORMAL,
  writer_followup:    PRIORITY.LOW,
  notify_discord:     PRIORITY.HIGH,
  notify_telegram:    PRIORITY.HIGH,
  notify_slack:       PRIORITY.HIGH,
  notify_email:       PRIORITY.HIGH,
  publish_article:    PRIORITY.URGENT,
  ingest_external:    PRIORITY.LOW,
  backfill_tags:      PRIORITY.BACKGROUND,
  backfill_embeddings: PRIORITY.BACKGROUND,
  maintenance_purge:  PRIORITY.BACKGROUND,
  maintenance_vacuum: PRIORITY.BACKGROUND,
};

// ── Retry limits ─────────────────────────────────────────────────────────────
const JOB_MAX_ATTEMPTS = {
  synthesize:         3,
  deep_dive:          3,
  topic_brief:        3,
  editorial_review:   3,
  generate_image:     3,
  generate_audio:     3,
  generate_embedding: 5,  // cheap + idempotent
  pitch_writer:       4,
  writer_followup:    3,
  notify_discord:     5,
  notify_telegram:    5,
  notify_slack:       5,
  notify_email:       5,
  publish_article:    3,
  ingest_external:    4,
  backfill_tags:      2,
  backfill_embeddings: 2,
  maintenance_purge:  2,
  maintenance_vacuum: 1,
};

// ── Stale thresholds (minutes) ───────────────────────────────────────────────
// How long a job can stay in 'running' before stale recovery resets it.
const JOB_STALE_MINUTES = {
  synthesize:         20,
  deep_dive:          25,
  topic_brief:        15,
  editorial_review:   15,
  generate_image:     10,
  generate_audio:     15,
  generate_embedding:  5,
  pitch_writer:       10,
  writer_followup:    10,
  notify_discord:      5,
  notify_telegram:     5,
  notify_slack:        5,
  notify_email:        5,
  publish_article:     5,
  ingest_external:    12,
  backfill_tags:      30,
  backfill_embeddings: 30,
  maintenance_purge:  10,
  maintenance_vacuum:  5,
};

// Max concurrent running jobs per tenant
const MAX_CONCURRENT_PER_TENANT = 2;

module.exports = {
  JOB_TYPE,
  JOB_CATEGORY,
  CATEGORY_MAP,
  PRIORITY,
  JOB_PRIORITY,
  JOB_MAX_ATTEMPTS,
  JOB_STALE_MINUTES,
  MAX_CONCURRENT_PER_TENANT,
};
