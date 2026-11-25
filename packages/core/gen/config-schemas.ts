// SPDX-License-Identifier: Apache-2.0
// GENERATED from proto/sessionpipe/v1/config.proto by tools/doors; do not edit. `npm run schemas` rewrites it.
// The JSON Schemas (draft 2020-12) of the machine's own files, keyed by name. Not the wire: none is
// published under schemas/v1.

import type { JsonSchema } from "./schemas.js";

export const CONFIG_SCHEMAS = {
  "triggers": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "v": {
        "type": "number",
        "const": 1
      },
      "on": {
        "type": "boolean"
      },
      "rules": {
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "pattern": "^[a-z0-9][a-z0-9_-]{0,39}$"
            },
            "paused": {
              "type": "boolean"
            },
            "source": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "receiver": {
                      "type": "string",
                      "maxLength": 259,
                      "pattern": "^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$"
                    },
                    "topic": {
                      "type": "string",
                      "pattern": "^[a-z0-9][a-z0-9._/-]{0,79}$"
                    },
                    "event": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_.]{0,39}$"
                    }
                  },
                  "required": [
                    "receiver",
                    "topic"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "every": {
                      "type": "string",
                      "pattern": "^(?:(?:mon|tue|wed|thu|fri|sat|sun|day) (?:[01][0-9]|2[0-3]):[0-5][0-9]|[1-9][0-9]{0,4}[mh])$"
                    }
                  },
                  "required": [
                    "every"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "when": {
              "type": "object",
              "properties": {
                "state": {
                  "minItems": 1,
                  "maxItems": 20,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[a-z0-9_-]{1,32}$"
                  },
                  "uniqueItems": true
                },
                "for": {
                  "minItems": 1,
                  "maxItems": 20,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$"
                  },
                  "uniqueItems": true
                },
                "by": {
                  "minItems": 1,
                  "maxItems": 20,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$"
                  },
                  "uniqueItems": true
                }
              },
              "additionalProperties": false
            },
            "subject": {
              "type": "string",
              "minLength": 2,
              "maxLength": 100,
              "pattern": "^\\^.*\\$$"
            },
            "target": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "start": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9-]{0,39}$"
                    }
                  },
                  "required": [
                    "start"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "continue": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$"
                    }
                  },
                  "required": [
                    "continue"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "folder": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024,
              "pattern": "^[^\\x00-\\x1f\\x7f-\\x9f]+$"
            },
            "level": {
              "type": "string",
              "enum": [
                "read",
                "safe",
                "edits",
                "auto"
              ]
            },
            "tools": {
              "maxItems": 8,
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^mcp__[A-Za-z0-9_-]{1,64}$"
              },
              "uniqueItems": true
            },
            "cap": {
              "type": "object",
              "properties": {
                "per_day": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 50
                }
              },
              "required": [
                "per_day"
              ],
              "additionalProperties": false
            },
            "words": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000,
              "pattern": "^[^\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]+$"
            }
          },
          "required": [
            "name",
            "paused",
            "source",
            "target",
            "folder",
            "level",
            "cap",
            "words"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "v",
      "on",
      "rules"
    ],
    "additionalProperties": false
  },
} as const satisfies Record<string, JsonSchema>;

/** A machine-local file's schema name. */
export type ConfigSchemaName = keyof typeof CONFIG_SCHEMAS;
