/**
 * Deprecated, use `server.address`, `server.port` attributes instead.
 *
 * @example "Server=(localdb)\\v11.0;Integrated Security=true;"
 *
 * @deprecated Replaced by `server.address` and `server.port`.
 */
export declare const ATTR_DB_CONNECTION_STRING: "db.connection_string";
/**
 * Deprecated, use `db.namespace` instead.
 *
 * @example customers
 * @example main
 *
 * @deprecated Replaced by `db.namespace`.
 */
export declare const ATTR_DB_NAME: "db.name";
/**
 * The database statement being executed.
 *
 * @example SELECT * FROM wuser_table
 * @example SET mykey "WuValue"
 *
 * @deprecated Replaced by `db.query.text`.
 */
export declare const ATTR_DB_STATEMENT: "db.statement";
/**
 * Deprecated, use `db.system.name` instead.
 *
 * @deprecated Replaced by `db.system.name`.
 */
export declare const ATTR_DB_SYSTEM: "db.system";
/**
 * Deprecated, no replacement at this time.
 *
 * @example readonly_user
 * @example reporting_user
 *
 * @deprecated Removed, no replacement at this time.
 */
export declare const ATTR_DB_USER: "db.user";
/**
 * Deprecated, use `server.address` on client spans and `client.address` on server spans.
 *
 * @example example.com
 *
 * @deprecated Replaced by `server.address` on client spans and `client.address` on server spans.
 */
export declare const ATTR_NET_PEER_NAME: "net.peer.name";
/**
 * Deprecated, use `server.port` on client spans and `client.port` on server spans.
 *
 * @example 8080
 *
 * @deprecated Replaced by `server.port` on client spans and `client.port` on server spans.
 */
export declare const ATTR_NET_PEER_PORT: "net.peer.port";
/**
 * Enum value "postgresql" for attribute {@link ATTR_DB_SYSTEM}.
 */
export declare const DB_SYSTEM_VALUE_POSTGRESQL: "postgresql";
//# sourceMappingURL=semconv.d.ts.map