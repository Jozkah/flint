# Website & Docs

This website is built using [Nextra](https://nextra.site/), a modern static website generator.

### Information Architecture

We try to **keep routes consistent** to maintain SEO.

- **`/guides/`**: Guides on how to use the Jan application. For end users who are directly using Jan.

- **`/developer/`**: Developer docs on how to extend Jan. These pages are about what people can build with our software.

- **`/api-reference/`**: Reference documentation for the Jan API server, written in Swagger/OpenAPI format.

- **`/changelog/`**: A list of changes made to the Jan application with each release.

- **`/blog/`**: A blog for the Jan application.

## How to Contribute

Refer to the [Contributing Guide](https://github.com/janhq/jan/blob/main/CONTRIBUTING.md) for more comprehensive information on how to contribute to the Jan project.

### Pre-requisites and Installation

- [Node.js](https://nodejs.org/en/) (version 20.0.0 or higher)
- [yarn](https://yarnpkg.com/) (version 1.22.0 or higher)

#### Installation

```bash
cd jan/docs
yarn install
yarn dev
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

#### Build

```bash
yarn build
```

This command builds the site as a Next.js static export into the `out` directory, which can be served by any static hosting service. To check the result locally:

```bash
yarn start
```

### Deployment

There is no deploy script. The site is published by the `Jan Docs` GitHub Actions workflow (`.github/workflows/jan-docs.yml`), which is run manually from the Actions tab: it runs `yarn build` and deploys the `docs/out` directory to Cloudflare Pages.

### Preview URL, Pre-release and Publishing Documentation

- When a pull request is created, the preview URL will be automatically commented on the pull request.

- The documentation will then be published to [https://jan.ai/](https://jan.ai/) when the pull request is merged to `main`.
