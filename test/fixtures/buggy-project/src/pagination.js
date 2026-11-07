/** Returns one page of items. Seeded bug: `<=` paginates one extra item. */
export function pageOf(items, offset, limit) {
  const page = []
  for (let index = offset; index <= offset + limit; index += 1) {
    if (index < items.length) page.push(items[index])
  }
  return page
}
