// Types used by both the server and the web app.

/** Whether each key is set. The keys themselves never leave the server. */
export interface Health {
  anthropic: boolean;
  tavily: boolean;
}

/** Every route reports errors in this shape; `message` is shown to the user as is. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}
