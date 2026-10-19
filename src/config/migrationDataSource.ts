/**
 * Entry point for the TypeORM CLI (`npm run migration:*`).
 *
 * The CLI requires the `-d` file to export exactly one DataSource, but
 * Datasource.ts exports it both as default and as `AppDataSource` for
 * application imports. Re-export only the default here so the CLI and the
 * application share the same configuration.
 */
import AppDataSource from "./Datasource";

export default AppDataSource;
