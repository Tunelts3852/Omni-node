export function requestTaskGraphList(send, options = {}) {
  return send({ type: "task_graph_list" }, options);
}

export function requestTaskGraphGet(send, graphId, options = {}) {
  return send({ type: "task_graph_get", graphId }, options);
}

export function requestTaskGraphCreate(send, planId, options = {}) {
  return send({ type: "task_graph_create", planId }, options);
}

export function requestTaskGraphRun(send, graphId, options = {}) {
  return send({ type: "task_graph_run", graphId }, options);
}

export function requestTaskCancel(send, graphId, taskId, options = {}) {
  return send({ type: "task_cancel", graphId, taskId }, options);
}

export function requestTaskOutput(send, graphId, taskId, options = {}) {
  return send({ type: "task_output_get", graphId, taskId }, options);
}
