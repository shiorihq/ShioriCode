import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(model_selection_json, '$.options.effort', 'max')
    WHERE json_extract(model_selection_json, '$.provider') = 'claudeAgent'
      AND json_extract(model_selection_json, '$.options.effort') = 'xhigh'
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(
      default_model_selection_json,
      '$.options.effort',
      'max'
    )
    WHERE json_extract(default_model_selection_json, '$.provider') = 'claudeAgent'
      AND json_extract(default_model_selection_json, '$.options.effort') = 'xhigh'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.modelSelection.options.effort', 'max')
    WHERE json_extract(payload_json, '$.modelSelection.provider') = 'claudeAgent'
      AND json_extract(payload_json, '$.modelSelection.options.effort') = 'xhigh'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.defaultModelSelection.options.effort', 'max')
    WHERE json_extract(payload_json, '$.defaultModelSelection.provider') = 'claudeAgent'
      AND json_extract(payload_json, '$.defaultModelSelection.options.effort') = 'xhigh'
  `;
});
