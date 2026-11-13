export const COURSERA = "https://www.coursera.org";
export const LEARNING = COURSERA + "/my-learning";
export const NATIVE_HOST = "org.coursera_queue.files";
export const PROVIDERS = {
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com"
};
export const defaults = { provider: "chatgpt", fallback: false, chatRequests: 30, quizDelaySeconds: 0, parallelEnabled: false, parallelKey: "" };
export const PARALLEL_ORIGIN = "http://127.0.0.1:8716";
export const PARALLEL_PERMISSION = { origins: ["http://127.0.0.1/*"] };
