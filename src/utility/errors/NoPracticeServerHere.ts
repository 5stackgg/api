/**
 * Turned away because nothing here could ever serve them, as opposed to
 * because everything is busy right now.
 *
 * The difference is the waitlist. Queuing is what puts a max length on whoever
 * is currently holding a server, so a row that can never be served costs every
 * other player time and buys the person who filed it nothing.
 */
export class NoPracticeServerHere extends Error {
  constructor(message = "no practice server can be started here") {
    super(message);
  }
}
