// SPDX-License-Identifier: Apache-2.0
// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.
// The protocol's JSON Schemas (draft 2020-12), the same bytes as schemas/v1/*.json, keyed by file name.

/** A JSON Schema, as the generator writes it: an object of keywords. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export const SCHEMAS = {
  "event": {
    "$id": "https://sessionpipe.org/schema/v1/event.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "protocol": {
        "type": "number",
        "const": 1
      },
      "id": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "type": {
        "type": "string",
        "pattern": "^(?:native|[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9_]*)+)$"
      },
      "time": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
      },
      "tier": {
        "type": "integer",
        "minimum": 0,
        "maximum": 3
      },
      "harness": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}$"
          },
          "version": {
            "type": "string",
            "maxLength": 64
          },
          "event": {
            "type": "string",
            "maxLength": 64
          }
        },
        "required": [
          "name"
        ]
      },
      "session": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9._:-]+$"
          },
          "seq": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "machine": {
            "type": "string",
            "maxLength": 80
          },
          "cwd": {
            "type": "string",
            "maxLength": 1024
          },
          "repo": {
            "type": "string",
            "maxLength": 512
          },
          "branch": {
            "type": "string",
            "maxLength": 256
          },
          "model": {
            "type": "string",
            "maxLength": 128
          },
          "title": {
            "type": "string",
            "maxLength": 200
          },
          "title_source": {
            "type": "string",
            "enum": [
              "custom",
              "harness",
              "first-ask"
            ]
          },
          "url": {
            "type": "string",
            "maxLength": 1024,
            "format": "uri"
          },
          "account_id": {
            "type": "string",
            "maxLength": 128
          },
          "attended": {
            "type": "boolean"
          },
          "parent_id": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
              },
              {
                "type": "null"
              }
            ]
          },
          "launched_by": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
          },
          "delegated_by": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
          }
        },
        "required": [
          "id",
          "seq"
        ]
      },
      "privacy": {
        "type": "object",
        "properties": {
          "rulesets": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]*@\\d+$"
            }
          },
          "pii": {
            "type": "boolean"
          }
        },
        "required": [
          "rulesets",
          "pii"
        ]
      },
      "data": {
        "type": "object",
        "propertyNames": {
          "type": "string"
        },
        "additionalProperties": {}
      }
    },
    "required": [
      "protocol",
      "id",
      "type",
      "time",
      "tier",
      "harness",
      "session",
      "privacy",
      "data"
    ]
  },
  "event-data": {
    "$id": "https://sessionpipe.org/schema/v1/event-data.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session.started": {
        "type": "object",
        "properties": {
          "source": {
            "type": "string",
            "enum": [
              "startup",
              "resume",
              "clear",
              "compact",
              "fork",
              "unknown"
            ]
          }
        },
        "required": [
          "source"
        ],
        "additionalProperties": {}
      },
      "session.heartbeat": {
        "type": "object",
        "properties": {},
        "additionalProperties": {}
      },
      "session.ended": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string",
            "enum": [
              "clear",
              "logout",
              "exit",
              "other"
            ]
          }
        },
        "required": [
          "reason"
        ],
        "additionalProperties": {}
      },
      "session.backfill": {
        "type": "object",
        "properties": {
          "started_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
          },
          "last_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
          },
          "turns": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "started_at",
          "last_at"
        ],
        "additionalProperties": {}
      },
      "session.forgotten": {
        "type": "object",
        "properties": {},
        "additionalProperties": {}
      },
      "turn.started": {
        "type": "object",
        "properties": {
          "turn_id": {
            "type": "string",
            "maxLength": 128
          },
          "prompt_chars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "submitted_by": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$"
          },
          "injected": {
            "type": "boolean"
          }
        },
        "additionalProperties": {}
      },
      "turn.ended": {
        "type": "object",
        "properties": {
          "turn_id": {
            "type": "string",
            "maxLength": 128
          },
          "reason": {
            "type": "string",
            "enum": [
              "stop",
              "interrupt",
              "error"
            ]
          },
          "error": {
            "type": "string",
            "maxLength": 200
          },
          "ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "background": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "reason"
        ],
        "additionalProperties": {}
      },
      "turn.transcript": {
        "type": "object",
        "properties": {
          "turn": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "user": {
            "type": "string",
            "maxLength": 20000
          },
          "assistant": {
            "type": "string",
            "maxLength": 20000
          },
          "at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
          },
          "injected": {
            "type": "boolean",
            "const": true
          }
        },
        "required": [
          "turn",
          "user",
          "assistant",
          "at"
        ],
        "additionalProperties": {}
      },
      "turn.progress": {
        "type": "object",
        "properties": {
          "turn": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "user": {
            "type": "string",
            "maxLength": 20000
          },
          "assistant": {
            "type": "string",
            "maxLength": 20000
          },
          "at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
          },
          "injected": {
            "type": "boolean",
            "const": true
          }
        },
        "required": [
          "turn",
          "user",
          "assistant",
          "at"
        ],
        "additionalProperties": {}
      },
      "tool.started": {
        "type": "object",
        "properties": {
          "tool": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_.:-]{1,120}$"
          },
          "call_id": {
            "type": "string",
            "maxLength": 128
          },
          "turn_id": {
            "type": "string",
            "maxLength": 128
          },
          "agent_id": {
            "type": "string",
            "maxLength": 128
          },
          "input": {}
        },
        "required": [
          "tool"
        ],
        "additionalProperties": {}
      },
      "tool.ended": {
        "type": "object",
        "properties": {
          "tool": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_.:-]{1,120}$"
          },
          "call_id": {
            "type": "string",
            "maxLength": 128
          },
          "turn_id": {
            "type": "string",
            "maxLength": 128
          },
          "agent_id": {
            "type": "string",
            "maxLength": 128
          },
          "ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "ok": {
            "type": "boolean"
          },
          "error": {
            "type": "string",
            "maxLength": 2000
          },
          "input": {},
          "output": {}
        },
        "required": [
          "tool",
          "ok"
        ],
        "additionalProperties": {}
      },
      "files.changed": {
        "type": "object",
        "properties": {
          "paths": {
            "maxItems": 500,
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 1024
            }
          }
        },
        "required": [
          "paths"
        ],
        "additionalProperties": {}
      },
      "attention.needed": {
        "type": "object",
        "properties": {
          "attention_id": {
            "type": "string",
            "maxLength": 128
          },
          "kind": {
            "type": "string",
            "enum": [
              "permission",
              "question",
              "elicitation",
              "idle",
              "error"
            ]
          },
          "tool": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_.:-]{1,120}$"
          },
          "message": {
            "type": "string",
            "maxLength": 200
          },
          "agent_id": {
            "type": "string",
            "maxLength": 128
          }
        },
        "required": [
          "attention_id",
          "kind"
        ],
        "additionalProperties": {}
      },
      "attention.cleared": {
        "type": "object",
        "properties": {
          "attention_id": {
            "type": "string",
            "maxLength": 128
          },
          "how": {
            "type": "string",
            "enum": [
              "answered",
              "cancelled",
              "timeout",
              "unknown"
            ]
          }
        },
        "required": [
          "attention_id",
          "how"
        ],
        "additionalProperties": {}
      },
      "subagent.started": {
        "type": "object",
        "properties": {
          "agent_id": {
            "type": "string",
            "maxLength": 128
          },
          "agent_type": {
            "type": "string",
            "maxLength": 128
          }
        },
        "required": [
          "agent_id"
        ],
        "additionalProperties": {}
      },
      "subagent.ended": {
        "type": "object",
        "properties": {
          "agent_id": {
            "type": "string",
            "maxLength": 128
          },
          "agent_type": {
            "type": "string",
            "maxLength": 128
          },
          "background": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "agent_id"
        ],
        "additionalProperties": {}
      },
      "context.compacted": {
        "type": "object",
        "properties": {
          "trigger": {
            "type": "string",
            "enum": [
              "manual",
              "auto"
            ]
          }
        },
        "required": [
          "trigger"
        ],
        "additionalProperties": {}
      },
      "limits.observed": {
        "type": "object",
        "properties": {
          "windows": {
            "minItems": 1,
            "maxItems": 8,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "pattern": "^[a-z0-9_]{1,64}$"
                },
                "used_percent": {
                  "type": "number",
                  "minimum": 0
                },
                "resets_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
                },
                "window_minutes": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "id",
                "used_percent"
              ],
              "additionalProperties": {}
            }
          },
          "plan": {
            "type": "string",
            "maxLength": 64
          },
          "account_id": {
            "type": "string",
            "maxLength": 128
          }
        },
        "required": [
          "windows"
        ],
        "additionalProperties": {}
      },
      "delegation.started": {
        "type": "object",
        "properties": {
          "ask_id": {
            "type": "string",
            "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
          },
          "via": {
            "type": "string",
            "enum": [
              "ask",
              "handoff"
            ]
          },
          "harness": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}$"
          },
          "to": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
          },
          "text": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "ask_id",
          "via",
          "harness"
        ],
        "additionalProperties": {}
      },
      "delegation.ended": {
        "type": "object",
        "properties": {
          "ask_id": {
            "type": "string",
            "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
          },
          "to": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
          },
          "ok": {
            "type": "boolean"
          },
          "ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "error": {
            "type": "string",
            "maxLength": 200
          },
          "relayed": {
            "type": "string",
            "enum": [
              "delivered",
              "unsupported",
              "failed"
            ]
          },
          "reply": {
            "type": "string",
            "maxLength": 20000
          }
        },
        "required": [
          "ask_id",
          "ok",
          "ms"
        ],
        "additionalProperties": {}
      },
      "native": {
        "type": "object",
        "properties": {},
        "additionalProperties": {}
      }
    },
    "required": [
      "session.started",
      "session.heartbeat",
      "session.ended",
      "session.backfill",
      "session.forgotten",
      "turn.started",
      "turn.ended",
      "turn.transcript",
      "turn.progress",
      "tool.started",
      "tool.ended",
      "files.changed",
      "attention.needed",
      "attention.cleared",
      "subagent.started",
      "subagent.ended",
      "context.compacted",
      "limits.observed",
      "delegation.started",
      "delegation.ended",
      "native"
    ]
  },
  "batch": {
    "$id": "https://sessionpipe.org/schema/v1/batch.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "events": {
        "minItems": 1,
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "protocol": {
              "type": "number",
              "const": 1
            },
            "id": {
              "type": "string",
              "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "type": {
              "type": "string",
              "pattern": "^(?:native|[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9_]*)+)$"
            },
            "time": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
            },
            "tier": {
              "type": "integer",
              "minimum": 0,
              "maximum": 3
            },
            "harness": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "pattern": "^[a-z][a-z0-9-]{0,39}$"
                },
                "version": {
                  "type": "string",
                  "maxLength": 64
                },
                "event": {
                  "type": "string",
                  "maxLength": 64
                }
              },
              "required": [
                "name"
              ]
            },
            "session": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9._:-]+$"
                },
                "seq": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "machine": {
                  "type": "string",
                  "maxLength": 80
                },
                "cwd": {
                  "type": "string",
                  "maxLength": 1024
                },
                "repo": {
                  "type": "string",
                  "maxLength": 512
                },
                "branch": {
                  "type": "string",
                  "maxLength": 256
                },
                "model": {
                  "type": "string",
                  "maxLength": 128
                },
                "title": {
                  "type": "string",
                  "maxLength": 200
                },
                "title_source": {
                  "type": "string",
                  "enum": [
                    "custom",
                    "harness",
                    "first-ask"
                  ]
                },
                "url": {
                  "type": "string",
                  "maxLength": 1024,
                  "format": "uri"
                },
                "account_id": {
                  "type": "string",
                  "maxLength": 128
                },
                "attended": {
                  "type": "boolean"
                },
                "parent_id": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9._:-]+$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "launched_by": {
                  "type": "string",
                  "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
                },
                "delegated_by": {
                  "type": "string",
                  "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
                }
              },
              "required": [
                "id",
                "seq"
              ]
            },
            "privacy": {
              "type": "object",
              "properties": {
                "rulesets": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9-]*@\\d+$"
                  }
                },
                "pii": {
                  "type": "boolean"
                }
              },
              "required": [
                "rulesets",
                "pii"
              ]
            },
            "data": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            }
          },
          "required": [
            "protocol",
            "id",
            "type",
            "time",
            "tier",
            "harness",
            "session",
            "privacy",
            "data"
          ]
        }
      }
    },
    "required": [
      "events"
    ]
  },
  "batch-response": {
    "$id": "https://sessionpipe.org/schema/v1/batch-response.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "accepted": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "duplicates": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "rejected": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "reason": {
              "type": "string",
              "maxLength": 200
            }
          },
          "required": [
            "id",
            "reason"
          ]
        }
      },
      "max_tier": {
        "type": "integer",
        "minimum": 0,
        "maximum": 3
      }
    },
    "required": [
      "accepted",
      "duplicates",
      "rejected",
      "max_tier"
    ]
  },
  "error": {
    "$id": "https://sessionpipe.org/schema/v1/error.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "maxLength": 200
      },
      "supported": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "max_tier": {
        "type": "integer",
        "minimum": 0,
        "maximum": 3
      }
    },
    "required": [
      "reason"
    ]
  },
  "well-known": {
    "$id": "https://sessionpipe.org/schema/v1/well-known.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "protocol": {
        "minItems": 1,
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "max_tier": {
        "type": "integer",
        "minimum": 0,
        "maximum": 3
      },
      "capabilities": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*$"
        }
      },
      "auth": {
        "default": [
          "bearer"
        ],
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "bearer"
          ]
        }
      },
      "endpoints": {
        "type": "object",
        "properties": {
          "events": {
            "type": "string"
          },
          "control": {
            "type": "string"
          },
          "native": {
            "type": "string"
          }
        },
        "required": [
          "events"
        ]
      },
      "batch": {
        "type": "object",
        "properties": {
          "max_events": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "max_bytes": {
            "type": "integer",
            "minimum": 1024,
            "maximum": 262144
          }
        },
        "required": [
          "max_events",
          "max_bytes"
        ]
      },
      "tools": {
        "type": "string",
        "enum": [
          "all",
          "main",
          "beat"
        ]
      },
      "control": {
        "type": "object",
        "properties": {
          "wait_max_s": {
            "type": "integer",
            "minimum": 1,
            "maximum": 60
          },
          "open_pairing": {
            "type": "boolean"
          },
          "session_tools": {
            "maxItems": 8,
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^mcp__[A-Za-z0-9_-]{1,64}$"
            }
          },
          "signing": {
            "type": "object",
            "properties": {
              "rp_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 253
              },
              "algs": {
                "minItems": 1,
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "number",
                      "const": -7
                    },
                    {
                      "type": "number",
                      "const": -257
                    }
                  ]
                }
              },
              "key_types": {
                "minItems": 1,
                "maxItems": 2,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "passkey",
                    "device"
                  ]
                }
              }
            },
            "required": [
              "rp_id",
              "algs"
            ]
          },
          "files": {
            "type": "boolean"
          },
          "inherit": {
            "type": "boolean"
          }
        },
        "required": [
          "wait_max_s",
          "signing"
        ]
      }
    },
    "required": [
      "protocol",
      "max_tier",
      "capabilities",
      "endpoints",
      "batch"
    ]
  },
  "control": {
    "$id": "https://sessionpipe.org/schema/v1/control.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "cmd": {
        "type": "string",
        "minLength": 1,
        "maxLength": 48000
      },
      "csig": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          {
            "type": "null"
          }
        ]
      },
      "grant": {
        "anyOf": [
          {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "cred": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "ad": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "cd": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "sig": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "str": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  }
                },
                "required": [
                  "cred",
                  "ad",
                  "cd",
                  "sig",
                  "str"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "cred": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "sig": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "str": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  }
                },
                "required": [
                  "cred",
                  "sig",
                  "str"
                ],
                "additionalProperties": false
              }
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "confirm": {
        "anyOf": [
          {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "cred": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "ad": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "cd": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "sig": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  }
                },
                "required": [
                  "cred",
                  "ad",
                  "cd",
                  "sig"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "cred": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "sig": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  }
                },
                "required": [
                  "cred",
                  "sig"
                ],
                "additionalProperties": false
              }
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
      },
      "expires_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
      }
    },
    "required": [
      "id",
      "cmd",
      "at",
      "expires_at"
    ]
  },
  "control-command": {
    "$id": "https://sessionpipe.org/schema/v1/control-command.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "v": {
        "type": "number",
        "const": 1
      },
      "t": {
        "type": "string",
        "const": "sessionpipe.control"
      },
      "machine": {
        "type": "string",
        "pattern": "^m_[A-Za-z0-9_-]{16,40}$"
      },
      "kind": {
        "type": "string",
        "enum": [
          "prompt",
          "permission.answer",
          "cancel",
          "start",
          "key.add",
          "pool"
        ]
      },
      "session": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
      },
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 20000
      },
      "for": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "decision": {
        "type": "string",
        "enum": [
          "allow",
          "deny"
        ]
      },
      "note": {
        "type": "string",
        "maxLength": 2000
      },
      "cwd": {
        "type": "string",
        "maxLength": 1024
      },
      "key": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 16,
                "maxLength": 1400,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "alg": {
                "anyOf": [
                  {
                    "type": "number",
                    "const": -7
                  },
                  {
                    "type": "number",
                    "const": -257
                  }
                ]
              },
              "spki": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              }
            },
            "required": [
              "id",
              "alg",
              "spki"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_-]{43}$"
              },
              "alg": {
                "type": "number",
                "const": -7
              },
              "spki": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "type": {
                "type": "string",
                "const": "device"
              },
              "store": {
                "type": "string",
                "const": "hardware"
              },
              "uv": {
                "type": "string",
                "const": "each-use"
              }
            },
            "required": [
              "id",
              "alg",
              "spki",
              "type",
              "store",
              "uv"
            ],
            "additionalProperties": false
          }
        ]
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "files": {
        "minItems": 1,
        "maxItems": 10,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "pattern": "^[^./\\\\\\x00-\\x1f\\x7f][^/\\\\\\x00-\\x1f\\x7f]*$"
            },
            "type": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$"
            },
            "size": {
              "type": "integer",
              "minimum": 1,
              "maximum": 26214400
            },
            "sha256": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{43}$"
            }
          },
          "required": [
            "name",
            "type",
            "size",
            "sha256"
          ]
        }
      },
      "permission": {
        "type": "string",
        "enum": [
          "read",
          "safe",
          "edits",
          "auto"
        ]
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@[\\]-]*$"
      },
      "pool_action": {
        "type": "string",
        "enum": [
          "on",
          "off",
          "enable",
          "disable",
          "remove",
          "order",
          "refresh",
          "login.begin",
          "login.complete"
        ]
      },
      "pool_account": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,128}$"
      },
      "pool_order": {
        "minItems": 1,
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:-]{1,128}$"
        },
        "uniqueItems": true
      },
      "pool_code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512,
        "pattern": "^[^\\r\\n]+$"
      },
      "reply_to": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
      },
      "nonce": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{22,64}$"
      },
      "iat": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "v",
      "t",
      "machine",
      "kind",
      "session",
      "nonce",
      "iat"
    ]
  },
  "control-grant": {
    "$id": "https://sessionpipe.org/schema/v1/control-grant.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "v": {
        "type": "number",
        "const": 1
      },
      "t": {
        "type": "string",
        "const": "sessionpipe.grant"
      },
      "pub": {
        "type": "string",
        "minLength": 1,
        "pattern": "^[A-Za-z0-9_-]*$"
      },
      "iat": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "exp": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "rp": {
        "type": "string",
        "minLength": 1,
        "maxLength": 253
      }
    },
    "required": [
      "v",
      "t",
      "pub",
      "iat",
      "exp",
      "rp"
    ]
  },
  "control-key": {
    "$id": "https://sessionpipe.org/schema/v1/control-key.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 16,
            "maxLength": 1400,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "alg": {
            "anyOf": [
              {
                "type": "number",
                "const": -7
              },
              {
                "type": "number",
                "const": -257
              }
            ]
          },
          "spki": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9_-]*$"
          }
        },
        "required": [
          "id",
          "alg",
          "spki"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]{43}$"
          },
          "alg": {
            "type": "number",
            "const": -7
          },
          "spki": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "type": {
            "type": "string",
            "const": "device"
          },
          "store": {
            "type": "string",
            "const": "hardware"
          },
          "uv": {
            "type": "string",
            "const": "each-use"
          }
        },
        "required": [
          "id",
          "alg",
          "spki",
          "type",
          "store",
          "uv"
        ],
        "additionalProperties": false
      }
    ]
  },
  "control-poll": {
    "$id": "https://sessionpipe.org/schema/v1/control-poll.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "messages": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "cmd": {
              "type": "string",
              "minLength": 1,
              "maxLength": 48000
            },
            "csig": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9_-]*$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "grant": {
              "anyOf": [
                {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "cred": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "ad": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "cd": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "sig": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "str": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        }
                      },
                      "required": [
                        "cred",
                        "ad",
                        "cd",
                        "sig",
                        "str"
                      ]
                    },
                    {
                      "type": "object",
                      "properties": {
                        "cred": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "sig": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "str": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        }
                      },
                      "required": [
                        "cred",
                        "sig",
                        "str"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "confirm": {
              "anyOf": [
                {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "cred": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "ad": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "cd": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "sig": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        }
                      },
                      "required": [
                        "cred",
                        "ad",
                        "cd",
                        "sig"
                      ]
                    },
                    {
                      "type": "object",
                      "properties": {
                        "cred": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        },
                        "sig": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]*$"
                        }
                      },
                      "required": [
                        "cred",
                        "sig"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
            },
            "expires_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
            }
          },
          "required": [
            "id",
            "cmd",
            "at",
            "expires_at"
          ]
        }
      }
    },
    "required": [
      "messages"
    ]
  },
  "control-ack": {
    "$id": "https://sessionpipe.org/schema/v1/control-ack.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "acks": {
        "minItems": 1,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "outcome": {
              "type": "string",
              "enum": [
                "progress",
                "taken",
                "delivered",
                "expired",
                "unsupported",
                "failed",
                "refused"
              ]
            },
            "at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
            },
            "mode": {
              "type": "string",
              "enum": [
                "sdk",
                "waiter",
                "turn",
                "inbox",
                "api",
                "resume",
                "fork"
              ]
            },
            "session": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
            },
            "copy_of": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
            },
            "code": {
              "type": "string",
              "pattern": "^[a-z_]{1,40}$"
            },
            "detail": {
              "type": "string",
              "maxLength": 500
            },
            "reply": {
              "type": "string",
              "maxLength": 20000
            },
            "seq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "applied": {
              "type": "object",
              "properties": {
                "permission": {
                  "type": "string",
                  "enum": [
                    "read",
                    "safe",
                    "edits",
                    "auto",
                    "inherit"
                  ]
                },
                "model": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 100,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@[\\]-]*$"
                }
              },
              "additionalProperties": false
            }
          },
          "required": [
            "id",
            "outcome",
            "at"
          ]
        }
      }
    },
    "required": [
      "acks"
    ]
  },
  "control-pair": {
    "$id": "https://sessionpipe.org/schema/v1/control-pair.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "poll_key": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{22,128}$"
      },
      "machine": {
        "type": "string",
        "pattern": "^m_[A-Za-z0-9_-]{16,40}$"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "harnesses": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,39}$"
        }
      },
      "modes": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "sdk",
            "waiter",
            "turn",
            "inbox",
            "api",
            "resume",
            "fork"
          ]
        }
      },
      "version": {
        "type": "string",
        "maxLength": 40
      },
      "folders": {
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 1024
        }
      },
      "mode": {
        "type": "string",
        "enum": [
          "safe",
          "auto",
          "inherit"
        ]
      },
      "accounts": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "harness": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{0,39}$"
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "email": {
              "type": "string",
              "maxLength": 254
            },
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "signed_in": {
              "type": "boolean"
            }
          },
          "required": [
            "harness",
            "id"
          ]
        }
      },
      "files": {
        "type": "boolean"
      },
      "key_types": {
        "minItems": 1,
        "maxItems": 2,
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "passkey",
            "device"
          ]
        }
      },
      "ask": {
        "type": "boolean"
      },
      "handoff": {
        "type": "boolean"
      }
    },
    "required": [
      "name",
      "harnesses",
      "modes",
      "version"
    ]
  },
  "control-pair-started": {
    "$id": "https://sessionpipe.org/schema/v1/control-pair-started.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "machine": {
        "type": "string",
        "pattern": "^m_[A-Za-z0-9_-]{16,40}$"
      },
      "code": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,32}$"
      },
      "url": {
        "type": "string",
        "format": "uri"
      },
      "check": {
        "type": "string",
        "pattern": "^\\d{6}$"
      },
      "expires_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
      }
    },
    "required": [
      "machine",
      "code",
      "url",
      "check",
      "expires_at"
    ]
  },
  "control-paired": {
    "$id": "https://sessionpipe.org/schema/v1/control-paired.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "pending",
          "paired",
          "expired"
        ]
      },
      "key": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 16,
                "maxLength": 1400,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "alg": {
                "anyOf": [
                  {
                    "type": "number",
                    "const": -7
                  },
                  {
                    "type": "number",
                    "const": -257
                  }
                ]
              },
              "spki": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              }
            },
            "required": [
              "id",
              "alg",
              "spki"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_-]{43}$"
              },
              "alg": {
                "type": "number",
                "const": -7
              },
              "spki": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "type": {
                "type": "string",
                "const": "device"
              },
              "store": {
                "type": "string",
                "const": "hardware"
              },
              "uv": {
                "type": "string",
                "const": "each-use"
              }
            },
            "required": [
              "id",
              "alg",
              "spki",
              "type",
              "store",
              "uv"
            ],
            "additionalProperties": false
          }
        ]
      },
      "proof": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "cred": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "ad": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "cd": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "sig": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              }
            },
            "required": [
              "cred",
              "ad",
              "cd",
              "sig"
            ]
          },
          {
            "type": "object",
            "properties": {
              "cred": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "sig": {
                "type": "string",
                "minLength": 1,
                "pattern": "^[A-Za-z0-9_-]*$"
              }
            },
            "required": [
              "cred",
              "sig"
            ],
            "additionalProperties": false
          }
        ]
      },
      "token": {
        "type": "string",
        "minLength": 16,
        "maxLength": 256
      },
      "sink_token": {
        "type": "string",
        "minLength": 16,
        "maxLength": 256
      },
      "account": {
        "type": "string",
        "maxLength": 200
      }
    },
    "required": [
      "status"
    ]
  },
  "control-hello": {
    "$id": "https://sessionpipe.org/schema/v1/control-hello.json",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "harnesses": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,39}$"
        }
      },
      "modes": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "sdk",
            "waiter",
            "turn",
            "inbox",
            "api",
            "resume",
            "fork"
          ]
        }
      },
      "keys": {
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 16,
          "maxLength": 1400,
          "pattern": "^[A-Za-z0-9_-]*$"
        }
      },
      "version": {
        "type": "string",
        "maxLength": 40
      },
      "waiting": {
        "maxItems": 500,
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
        }
      },
      "folders": {
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 1024
        }
      },
      "mode": {
        "type": "string",
        "enum": [
          "safe",
          "auto",
          "inherit"
        ]
      },
      "accounts": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "harness": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{0,39}$"
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "email": {
              "type": "string",
              "maxLength": 254
            },
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "signed_in": {
              "type": "boolean"
            }
          },
          "required": [
            "harness",
            "id"
          ]
        }
      },
      "files": {
        "type": "boolean"
      },
      "prompt_files": {
        "type": "boolean"
      },
      "start": {
        "type": "object",
        "propertyNames": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,39}$"
        },
        "additionalProperties": {
          "type": "object",
          "properties": {
            "permissions": {
              "minItems": 1,
              "maxItems": 4,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "read",
                  "safe",
                  "edits",
                  "auto"
                ]
              },
              "uniqueItems": true
            },
            "permission": {
              "type": "string",
              "enum": [
                "read",
                "safe",
                "edits",
                "auto",
                "inherit"
              ]
            },
            "models": {
              "maxItems": 50,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 100,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@[\\]-]*$"
              }
            },
            "any_model": {
              "type": "boolean"
            }
          },
          "required": [
            "permissions",
            "permission"
          ]
        },
        "maxProperties": 50
      },
      "key_types": {
        "minItems": 1,
        "maxItems": 2,
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "passkey",
            "device"
          ]
        }
      },
      "pool": {
        "type": "object",
        "properties": {
          "on": {
            "type": "boolean"
          },
          "harness": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,39}$"
          },
          "accounts": {
            "maxItems": 20,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:-]{1,128}$"
                },
                "email": {
                  "type": "string",
                  "maxLength": 254
                },
                "label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 80
                },
                "enabled": {
                  "type": "boolean"
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "ready",
                    "limited",
                    "error",
                    "disabled"
                  ]
                },
                "current": {
                  "type": "boolean"
                },
                "until": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
                },
                "windows": {
                  "minItems": 1,
                  "maxItems": 8,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "pattern": "^[a-z0-9_]{1,64}$"
                      },
                      "used_percent": {
                        "type": "number",
                        "minimum": 0
                      },
                      "resets_at": {
                        "type": "string",
                        "format": "date-time",
                        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
                      },
                      "window_minutes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9007199254740991
                      }
                    },
                    "required": [
                      "id",
                      "used_percent"
                    ],
                    "additionalProperties": {}
                  }
                },
                "limited_by": {
                  "type": "string",
                  "pattern": "^[a-z0-9_]{1,64}$"
                }
              },
              "required": [
                "id",
                "enabled",
                "status"
              ]
            }
          }
        },
        "required": [
          "on",
          "harness",
          "accounts"
        ]
      },
      "ask": {
        "type": "boolean"
      },
      "handoff": {
        "type": "boolean"
      }
    },
    "required": [
      "name",
      "harnesses",
      "modes",
      "keys",
      "version"
    ]
  },
} as const satisfies Record<string, JsonSchema>;

/** A schema's name: its file under schemas/v1 without `.json`. */
export type SchemaName = keyof typeof SCHEMAS;
