/** Fictional sign-in export used to exercise the lab without a customer log. */
export const SAMPLE_EVIDENCE_NAME = 'sample-sign-in-log.json'

export const SAMPLE_EVIDENCE = `[
  {"time":"2026-04-02T01:11:03Z","actor":"morgan@example.com","action":"auth.failure","ip":"203.0.113.44","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T01:11:41Z","actor":"morgan@example.com","action":"auth.failure","ip":"203.0.113.44","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T01:12:18Z","actor":"morgan@example.com","action":"auth.failure","ip":"203.0.113.44","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T01:12:55Z","actor":"morgan@example.com","action":"auth.success","ip":"203.0.113.44","result":"success","detail":"password"},
  {"time":"2026-04-02T01:18:02Z","actor":"morgan@example.com","action":"role.grant","ip":"203.0.113.44","result":"success","detail":"added to Global Administrator"},
  {"time":"2026-04-02T01:20:11Z","actor":"riley@example.com","action":"auth.failure","ip":"203.0.113.44","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T01:20:40Z","actor":"sam@example.com","action":"auth.failure","ip":"203.0.113.44","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T01:21:05Z","actor":"quinn@example.com","action":"auth.failure","ip":"203.0.113.44","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T03:02:00Z","actor":"casey@example.com","action":"inbox.rule.create","ip":"198.51.100.20","result":"success","detail":"forward all mail to offsite@example.net"},
  {"time":"2026-04-02T04:00:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:01:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:02:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:03:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:04:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:05:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:06:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"},
  {"time":"2026-04-02T04:07:00Z","actor":"jamie@example.com","action":"auth.failure","ip":"198.51.100.9","result":"failure","detail":"invalid password"}
]
`
