// A GIPHY GIF by id. The web builds the media URL from the id, so a message can
// never carry an arbitrary URL dressed up as a GIF.
export interface ChatGif {
  id: string;
  width: number;
  height: number;
}
