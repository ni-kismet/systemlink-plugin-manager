// @ts-check
/** @type {import('beachball').BeachballConfig} */
module.exports = {
  /** Point at the single versioned package. */
  packages: ['webapp'],

  /** We manage git tags ourselves via GitHub Releases. */
  gitTags: false,

  /** Not a public npm package. */
  npmPublish: false,

  /** All change types are allowed. */
  disallowedChangeTypes: [],

  /** Place the changelog next to the package. */
  changelog: {
    groups: [
      {
        masterPackageName: 'systemlink-app-store',
        changelogPath: 'webapp',
        include: ['webapp'],
      },
    ],
  },
};
