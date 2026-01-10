# frozen_string_literal: true

module DuplicatePostGuard
  def self.collect_duplicates(items, label)
    duplicates = items.select { |_, posts| posts.size > 1 }
    return if duplicates.empty?

    lines = duplicates.map do |key, posts|
      paths = posts.map(&:path).join(", ")
      "- #{label} '#{key}' appears #{posts.size} times: #{paths}"
    end

    lines.join("\n")
  end

  def self.guard!(posts)
    slug_map = Hash.new { |hash, key| hash[key] = [] }
    id_map = Hash.new { |hash, key| hash[key] = [] }
    url_map = Hash.new { |hash, key| hash[key] = [] }
    title_date_map = Hash.new { |hash, key| hash[key] = [] }
    title_map = Hash.new { |hash, key| hash[key] = [] }

    posts.each do |post|
      slug = post.data["slug"].to_s.strip
      slug = post.slug.to_s.strip if slug.empty?
      slug_map[slug] << post unless slug.empty?

      id = post.data["id"].to_s.strip
      id_map[id] << post unless id.empty?

      url = post.url.to_s.strip
      url_map[url] << post unless url.empty?

      title = post.data["title"].to_s.strip
      date = post.data["date"]
      title_date_key = [title, date].join("|")
      title_date_map[title_date_key] << post unless title.empty? || date.nil?

      normalized_title = title.downcase.gsub(/\s+/, " ").strip
      title_map[normalized_title] << post unless normalized_title.empty?
    end

    errors = []
    slug_duplicates = collect_duplicates(slug_map, "slug")
    errors << slug_duplicates if slug_duplicates

    id_duplicates = collect_duplicates(id_map, "id")
    errors << id_duplicates if id_duplicates

    url_duplicates = collect_duplicates(url_map, "url")
    errors << url_duplicates if url_duplicates

    title_date_duplicates = collect_duplicates(title_date_map, "title+date")
    title_duplicates = collect_duplicates(title_map, "title")

    warnings = []
    warnings << "Possible duplicate titles detected:\n#{title_duplicates}" if title_duplicates
    warnings << "Possible duplicate titles with matching dates detected:\n#{title_date_duplicates}" if title_date_duplicates
    warning_text = warnings.empty? ? "" : "\n#{warnings.join("\n")}"

    return if errors.empty? && warning_text.empty?

    message = <<~MSG
      Duplicate blog post guardrail triggered.
      #{errors.join("\n")}
      #{warning_text}

      Fix by ensuring unique slug and id fields in _posts front matter.
    MSG

    if errors.any? && (ENV["CI"] || ENV["JEKYLL_ENV"] == "production")
      raise Jekyll::Errors::FatalException, message
    end

    if errors.any?
      Jekyll.logger.error("DuplicatePostGuard:", message)
    else
      Jekyll.logger.warn("DuplicatePostGuard:", message)
    end
  end
end

Jekyll::Hooks.register :site, :post_read do |site|
  DuplicatePostGuard.guard!(site.posts.docs)
end
