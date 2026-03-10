export function requestDoctorRun(send, options = {}) {
  return send({ type: "doctor_run" }, options);
}

export function requestDoctorLast(send, options = {}) {
  return send({ type: "doctor_get_last" }, options);
}
