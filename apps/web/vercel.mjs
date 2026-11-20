// Evaluated by Vercel for each frontend deployment.
const origin = process.env.GROVE_API_ORIGIN?.replace(/\/$/, '');
if (!origin || !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
  throw new Error('Set GROVE_API_ORIGIN to the HTTPS origin of the Grove backend project.');
}

export const config = {
  rewrites: [{ source: '/api/:path*', destination: origin + '/api/:path*' }],
};
