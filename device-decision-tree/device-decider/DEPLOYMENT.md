# GitHub Pages Deployment Guide

This guide explains how to deploy the DeviceDecisionApp to GitHub Pages.

## Prerequisites

1. Your code is in a GitHub repository
2. You have admin access to the repository

## Setup Steps

### 1. Enable GitHub Pages

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Pages**
3. Under **Source**, select **GitHub Actions**
4. This will allow the workflow to deploy automatically

### 2. Configure Repository Settings

1. In **Settings** → **Pages**:
   - Source: **GitHub Actions**
   - Branch: Leave as default (will be set by workflow)

### 3. Push Your Code

The GitHub Actions workflow will automatically:
- Build your Next.js application
- Generate static files
- Deploy to GitHub Pages

```bash
git add .
git commit -m "Configure for GitHub Pages deployment"
git push origin main
```

### 4. Monitor Deployment

1. Go to **Actions** tab in your repository
2. You should see the "Deploy to GitHub Pages" workflow running
3. Once complete, your app will be available at: `https://[username].github.io/[repository-name]`

## Local Development

For local development, use:
```bash
npm run dev
```

For testing the production build locally:
```bash
npm run build
npm run start
```

## Troubleshooting

### Common Issues

1. **Build fails**: Check the Actions tab for error details
2. **Assets not loading**: Ensure `basePath` and `assetPrefix` are correctly set
3. **404 errors**: Make sure `trailingSlash: true` is set in `next.config.ts`

### Manual Deployment

If you need to deploy manually:

1. Build the project:
   ```bash
   npm run build
   ```

2. The static files will be in the `out/` directory
3. You can serve these files with any static file server

## Configuration Notes

- The app is configured to work with the repository name `stateoverflow`
- If you change the repository name, update the `basePath` in `next.config.ts`
- Static export is enabled for GitHub Pages compatibility
- Images are set to unoptimized mode for static hosting

