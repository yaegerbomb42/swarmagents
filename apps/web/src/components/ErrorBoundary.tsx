import React from 'react';

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [error, setError] = React.useState<Error | null>(null);

  const handleError = (err: Error) => {
    setError(err);
  };

  return (
    <React.Fragment>
      {children}
      {error && (
        <div className="error-boundary">
          <h2>Something went wrong!</h2>
          <p>{error.message}</p>
        </div>
      )}
    </React.Fragment>
  );
};

export default ErrorBoundary;