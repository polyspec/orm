"""The public generated-model query for the CPX-2 product search fixture."""

import json
from pathlib import Path

from polyspec.orm import orm

ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = ROOT / "contracts" / "fixtures" / "complex_query"
SCHEMA_PATH = FIXTURE_DIR / "complex_query.dbs"
FIXTURE = json.loads((FIXTURE_DIR / "complex_query.json").read_text(encoding="utf-8"))


def product_search_query(models, input_values):
    category = (
        models.ProductMatchCategory()
        .remove_all_columns()
        .add_column_product_seq()
        .service_region_category_item_seq(input_values["category_seqs"])
    )
    brand_lang = (
        models.ProductBrandLang()
        .remove_all_columns()
        .add_column_product_brand_seq()
        .fulltext_boolean_name_with_description(input_values["keyword"])
    )
    lang = (
        models.ProductLang()
        .remove_all_columns()
        .add_column_product_seq()
        .fulltext_boolean_name_with_short_description_with_content(
            input_values["keyword"]
        )
    )

    return (
        models.Product()
        .relation(
            models.ProductLang()
            .match_seq_with_product_seq()
            .lang_id(input_values["lang_id"])
            .parent_node()
        )
        .relation(
            models.ProductBrand()
            .match_product_brand_seq_with_seq()
            .alias_brand()
            .relation(
                models.ProductBrandLang()
                .match_seq_with_product_brand_seq()
                .lang_id(input_values["lang_id"])
                .parent_node()
            )
        )
        .relations(
            models.ProductReview()
            .match_seq_with_product_seq()
            .alias_reviews()
            .is_close(False)
            .order_by_seq_desc()
            .group_limit(3)
            .key_name_seq()
            .relation(
                models.User()
                .match_user_seq_with_seq()
                .alias_user()
                .remove_all_columns()
                .add_column_name()
                .add_column_profile_url()
            )
        )
        .relation(
            models.OrderProductItem()
            .match_seq_with_product_seq()
            .alias_my_order_item()
            .service_member_seq(input_values["member_seq"])
            .and_is_close(False)
            .order_by_seq_desc()
            .group_limit(1)
        )
        .service_seq(input_values["service_seq"])
        .and_seq(category)
        .and_is_close(False)
        .and_is_display(True)
        .and_(
            lambda query: query.is_allday(True).or_(
                lambda query: (
                    query.is_allday(False)
                    .and_le_display_start_dt(orm.now())
                    .and_ge_display_end_dt(orm.now())
                )
            )
        )
        .and_(
            lambda query: (
                query.fulltext_boolean_name_with_short_description_with_content(
                    input_values["keyword"]
                )
                .or_product_brand_seq(brand_lang)
                .or_seq(lang)
            )
        )
        .order_by_like_count_desc_and_seq_desc()
    )
