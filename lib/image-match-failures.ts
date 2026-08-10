export type ImageMatchFailure = { imageUrl: string; message: string };
export type ImageMatchFailureReason = { message: string; count: number; imageIndexes: number[] };

export function groupImageMatchFailures(imageUrls: string[], failures: ImageMatchFailure[], realtimeLimit: number): ImageMatchFailureReason[] {
  const uniqueUrls = [...new Set(imageUrls)];
  const imageIndexes = new Map(uniqueUrls.map((imageUrl, index) => [imageUrl, index + 1]));
  const groups = new Map<string, Set<number>>();
  const add = (message: string, index: number) => {
    const reason = message.trim() || "识别服务未返回具体错误";
    const indexes = groups.get(reason) || new Set<number>();
    indexes.add(index); groups.set(reason, indexes);
  };
  for (const failure of failures) {
    const index = imageIndexes.get(failure.imageUrl);
    if (index !== undefined) add(failure.message, index);
  }
  for (let index = realtimeLimit; index < uniqueUrls.length; index += 1) {
    add(`超过单次实时识别上限（${realtimeLimit} 张），本次未参与识别`, index + 1);
  }
  return [...groups.entries()].map(([message, indexes]) => ({
    message,
    count: indexes.size,
    imageIndexes: [...indexes].sort((left, right) => left - right),
  }));
}
