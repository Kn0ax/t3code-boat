/**
 * This build keeps its data apart from the official T3 Code app, so both can
 * run on one machine without sharing a database, identity or secrets.
 */
export const DEFAULT_T3_HOME_DIRNAME = ".t3-boat";

/** The official app's default home, the source a first run can copy from. */
export const OFFICIAL_T3_HOME_DIRNAME = ".t3";
